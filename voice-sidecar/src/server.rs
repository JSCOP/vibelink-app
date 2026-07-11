use std::net::SocketAddr;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{OriginalUri, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::protocol::{ClientCommand, ClientEnvelope, ServerEvent};
use crate::state::SharedState;

#[derive(Clone)]
struct ServerState {
    sidecar: SharedState,
    token: String,
}

pub fn router(state: SharedState, token: String) -> Router {
    Router::new()
        .route("/ws", any(ws_handler))
        .with_state(ServerState {
            sidecar: state,
            token,
        })
}

pub async fn run(host: &str, port: u16, state: SharedState, token: String) -> Result<()> {
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "sidecar_server_listening");
    axum::serve(listener, router(state, token)).await?;
    Ok(())
}

async fn ws_handler(
    State(state): State<ServerState>,
    OriginalUri(uri): OriginalUri,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_authorized_ws_path(&uri.to_string(), &state.token) {
        warn!("websocket_auth_rejected");
        return StatusCode::UNAUTHORIZED.into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state.sidecar))
        .into_response()
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<ServerEvent>();
    let connection_id = state.connect(sender);

    state.send_event(ServerEvent::ready());
    info!(%connection_id, "websocket_connected");

    let writer = tokio::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match serde_json::to_string(&event) {
                Ok(payload) => {
                    if sink.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(err) => warn!(error = %err, "ws_event_serialize_failed"),
            }
        }
    });

    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Text(text)) => dispatch_text(&state, &text).await,
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) => state.send_event(ServerEvent::new(
                crate::protocol::ServerEventKind::Pong,
                None,
            )),
            Ok(Message::Pong(_)) => debug!("websocket_frame_pong"),
            Ok(Message::Binary(_)) => warn!("websocket_binary_ignored"),
            Err(err) => {
                error!(error = %err, "websocket_receive_failed");
                break;
            }
        }
    }

    state.disconnect(connection_id);
    writer.abort();
    info!(%connection_id, "websocket_disconnected");
}

async fn dispatch_text(state: &SharedState, text: &str) {
    let message = match serde_json::from_str::<ClientEnvelope>(text) {
        Ok(message) => message,
        Err(err) => {
            state.send_error(
                format!("Invalid JSON message: {err}"),
                "invalid_message",
                false,
                Some(true),
                None,
            );
            return;
        }
    };

    let correlation_id = message.correlation_id;
    match message.command {
        ClientCommand::Ping => state.send_event(ServerEvent::pong(correlation_id)),
        ClientCommand::GetStatus => state.handle_get_status(correlation_id).await,
        ClientCommand::GetDevices => state.handle_get_devices(correlation_id).await,
        ClientCommand::SetConfig { config } => {
            state.handle_set_config(config, correlation_id).await
        }
        ClientCommand::StartRecording => state.handle_start_recording(correlation_id).await,
        ClientCommand::StopRecording => state.handle_stop_recording(correlation_id).await,
        ClientCommand::CancelRecording => state.handle_cancel_recording(correlation_id).await,
    }
}

fn is_authorized_ws_path(path: &str, expected_token: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }

    let Some((route, query)) = path.split_once('?') else {
        return false;
    };
    if route != "/ws" {
        return false;
    }

    query.split('&').any(|param| {
        let Some((key, value)) = param.split_once('=') else {
            return false;
        };
        key == "token" && value == expected_token
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_auth_requires_matching_token_query_param() {
        assert!(is_authorized_ws_path(
            "/ws?token=session-secret",
            "session-secret"
        ));
        assert!(!is_authorized_ws_path("/ws", "session-secret"));
        assert!(!is_authorized_ws_path("/ws?token=wrong", "session-secret"));
    }
}
