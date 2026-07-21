use super::error::CliError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectorCandidate<T> {
    pub value: T,
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
}

impl<T> SelectorCandidate<T> {
    pub fn new(value: T, id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            value,
            id: id.into(),
            name: name.into(),
            aliases: Vec::new(),
        }
    }

    pub fn with_aliases(mut self, aliases: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.aliases = aliases.into_iter().map(Into::into).collect();
        self
    }
}

pub fn resolve_selector<'a, T>(
    kind: &str,
    query: &str,
    candidates: &'a [SelectorCandidate<T>],
) -> Result<&'a T, CliError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(CliError::invalid(format!(
            "{kind} selector cannot be empty"
        )));
    }

    let id_matches = candidates
        .iter()
        .filter(|candidate| candidate.id == query)
        .collect::<Vec<_>>();
    match id_matches.as_slice() {
        [candidate] => return Ok(&candidate.value),
        [] => {}
        matches => {
            return Err(CliError::ambiguous(
                kind,
                query,
                matches
                    .iter()
                    .map(|candidate| candidate.id.clone())
                    .collect(),
            ))
        }
    }

    let query_folded = query.to_lowercase();
    let matches = candidates
        .iter()
        .filter(|candidate| {
            candidate.name.to_lowercase() == query_folded
                || candidate
                    .aliases
                    .iter()
                    .any(|alias| alias.to_lowercase() == query_folded)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [candidate] => Ok(&candidate.value),
        [] => Err(CliError::not_found(kind, query)),
        matches => Err(CliError::ambiguous(
            kind,
            query,
            matches
                .iter()
                .map(|candidate| candidate.id.clone())
                .collect(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_id_wins_over_duplicate_names() {
        let candidates = vec![
            SelectorCandidate::new(1, "workspace-1", "Project"),
            SelectorCandidate::new(2, "workspace-2", "Project"),
        ];
        assert_eq!(
            *resolve_selector("workspace", "workspace-2", &candidates).expect("id selector"),
            2
        );
    }

    #[test]
    fn duplicate_names_are_rejected_as_ambiguous() {
        let candidates = vec![
            SelectorCandidate::new(1, "workspace-1", "Project"),
            SelectorCandidate::new(2, "workspace-2", "project"),
        ];
        let error = resolve_selector("workspace", "PROJECT", &candidates)
            .expect_err("ambiguous selector must fail");
        assert_eq!(
            error.code,
            crate::dedicated_cli::ErrorCode::AmbiguousSelector
        );
        assert_eq!(
            error.details.expect("details")["matches"],
            serde_json::json!(["workspace-1", "workspace-2"])
        );
    }

    #[test]
    fn aliases_are_case_insensitive_but_still_ambiguity_safe() {
        let candidates = vec![
            SelectorCandidate::new(1, "pane-1", "Shell").with_aliases(["primary"]),
            SelectorCandidate::new(2, "pane-2", "Agent"),
        ];
        assert_eq!(
            *resolve_selector("pane", "PRIMARY", &candidates).expect("alias selector"),
            1
        );
    }
}
