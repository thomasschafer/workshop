//! Child processes that are stopped together with everything they start.
//!
//! Killing only the direct child isn't enough: a compiler driver, a shell or a language server
//! can start processes of their own, which keep running (and keep output pipes open) after their
//! parent is killed. Each child is therefore started in its own process group, and the whole
//! group is killed.

use std::ffi::OsStr;

use tokio::process::{Child, Command};

/// A command whose process will lead its own process group.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(unix)]
    command.process_group(0);
    command.kill_on_drop(true);
    command
}

/// Kills a child's process group when dropped, unless disarmed first.
///
/// Only kill while the group leader hasn't been reaped, or straight after: once it's gone, the
/// group ID could eventually be reused by an unrelated process.
pub struct ProcessGroup {
    #[cfg_attr(not(unix), allow(dead_code))]
    id: Option<u32>,
}

impl ProcessGroup {
    pub fn of(child: &Child) -> Self {
        Self { id: child.id() }
    }

    /// Kills every process in the group.
    pub fn kill(&self) {
        #[cfg(unix)]
        if let Some(id) = self.id.and_then(|id| libc::pid_t::try_from(id).ok()) {
            // SAFETY: `killpg` has no memory-safety preconditions. The group was created for
            // this child, and its ID is only reused once every member has exited and been reaped.
            unsafe {
                libc::killpg(id, libc::SIGKILL);
            }
        }
    }

    /// Kills anything left in the group, then stops tracking it, so it's never killed again.
    /// Only call it once the leader has been reaped, straight after.
    pub fn finish(mut self) {
        self.reaped();
    }

    /// Like `finish`, for a group that's kept: anything left in it is killed, and later kills do
    /// nothing, as its ID could by then belong to another group.
    pub fn reaped(&mut self) {
        self.kill();
        self.id = None;
    }
}

/// A child together with its process group, which is killed when this is dropped.
pub struct GroupedChild {
    pub child: Child,
    group: ProcessGroup,
}

impl GroupedChild {
    pub fn spawn(command: &mut Command) -> std::io::Result<Self> {
        let child = command.spawn()?;
        let group = ProcessGroup::of(&child);
        Ok(Self { child, group })
    }

    /// Kills the child and everything in its group, without waiting for them to exit. Once the
    /// child has been reaped and `reaped` called, it kills nothing.
    pub fn kill(&mut self) {
        self.group.kill();
        // Where there are no process groups, this is all that stops it. It fails only if the
        // child has already exited.
        let _ = self.child.start_kill();
    }

    /// Kills anything left in the group, straight after the child has been reaped, such as a
    /// grandchild still holding its output open, and stops tracking the group.
    pub fn reaped(&mut self) {
        self.group.reaped();
    }

    /// Kills anything left in the group once the child has exited.
    pub fn finish(self) {
        let Self { child, group } = self;
        group.finish();
        drop(child);
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn killing_the_group_stops_grandchildren() {
        let mut child = command("sh")
            .args(["-c", "sleep 30 & sleep 30"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let group = ProcessGroup::of(&child);
        let started = Instant::now();
        group.kill();
        child.wait().await.unwrap();
        // The pipe only closes once the backgrounded grandchild has gone too.
        let mut rest = Vec::new();
        stdout.read_to_end(&mut rest).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        group.finish();
    }
}
