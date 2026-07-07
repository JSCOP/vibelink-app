use std::collections::{HashMap, HashSet, VecDeque};

use sysinfo::{Pid, ProcessesToUpdate, System};

/// Collect every descendant PID below `root` from a parent -> children map.
pub fn descendant_pids(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::new();

    if let Some(kids) = children.get(&root) {
        for &kid in kids {
            queue.push_back(kid);
        }
    }

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                queue.push_back(kid);
            }
        }
    }

    out
}

fn child_map(sys: &System) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            map.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    map
}

/// Kill `root` first, then every currently visible descendant process deepest-first.
pub fn kill_process_tree(root: u32) {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let children = child_map(&sys);
    let mut descendants = descendant_pids(&children, root);

    if let Some(process) = sys.process(Pid::from_u32(root)) {
        let _ = process.kill();
    }

    descendants.reverse();
    for pid in descendants {
        if let Some(process) = sys.process(Pid::from_u32(pid)) {
            let _ = process.kill();
        }
    }
}

/// Return working-set bytes and process count for `root` plus all descendants.
pub fn tree_metrics(sys: &System, root: u32) -> (u64, u32) {
    let children = child_map(sys);
    let mut pids = descendant_pids(&children, root);
    pids.push(root);

    let mut mem_bytes = 0u64;
    let mut process_count = 0u32;
    for pid in pids {
        if let Some(process) = sys.process(Pid::from_u32(pid)) {
            mem_bytes += process.memory();
            process_count += 1;
        }
    }

    (mem_bytes, process_count)
}

#[cfg(test)]
mod tests {
    use super::{child_map, descendant_pids, kill_process_tree};
    use std::{
        collections::{HashMap, HashSet},
        process::Command,
        thread,
        time::{Duration, Instant},
    };
    use sysinfo::{Pid, ProcessesToUpdate, System};

    #[test]
    fn descendant_pids_returns_only_root_descendants() {
        let mut children = HashMap::new();
        children.insert(10, vec![11, 13]);
        children.insert(11, vec![12]);
        children.insert(20, vec![21]);

        let descendants: HashSet<_> = descendant_pids(&children, 10).into_iter().collect();

        assert_eq!(descendants, HashSet::from([11, 12, 13]));
        assert!(!descendants.contains(&10));
        assert!(!descendants.contains(&20));
        assert!(!descendants.contains(&21));
    }

    #[cfg(windows)]
    #[test]
    fn kill_process_tree_terminates_spawned_descendants() {
        let mut root = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -Command Start-Sleep -Seconds 60' -PassThru; Start-Sleep -Seconds 60",
            ])
            .spawn()
            .expect("spawn root powershell");
        let root_pid = root.id();

        let targets = wait_for_descendant(root_pid);
        kill_process_tree(root_pid);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            if targets
                .iter()
                .all(|pid| sys.process(Pid::from_u32(*pid)).is_none())
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = root.kill();
                panic!("process tree still alive after kill_process_tree: {targets:?}");
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[cfg(windows)]
    fn wait_for_descendant(root_pid: u32) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let children = child_map(&sys);
            let mut targets = descendant_pids(&children, root_pid);
            targets.push(root_pid);
            if targets.len() >= 2 {
                return targets;
            }
            if Instant::now() >= deadline {
                kill_process_tree(root_pid);
                panic!("spawned powershell descendant did not appear");
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}
