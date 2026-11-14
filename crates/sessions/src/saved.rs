//! Sessions kept as JSON files in Workshop's data directory, one per item, by its key.

use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Sessions of one sort, such as design sessions, kept by item as `pack/item`.
pub struct Saved<T> {
    dir: PathBuf,
    /// Held while a session is changed, so two changes can't both start from the same one.
    lock: Mutex<()>,
    sort: PhantomData<fn() -> T>,
}

impl<T: Serialize + DeserializeOwned> Saved<T> {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
            sort: PhantomData,
        }
    }

    fn path(&self, key: &str) -> Result<PathBuf> {
        let Some((pack, item)) = key.split_once('/') else {
            bail!("{key:?} isn't an item's key");
        };
        let slug = |part: &str| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        };
        if !slug(pack) || !slug(item) {
            bail!("{key:?} isn't an item's key");
        }
        Ok(self.dir.join(pack).join(format!("{item}.json")))
    }

    pub fn get(&self, key: &str) -> Result<Option<T>> {
        let path = self.path(key)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(
                serde_json::from_str(&text)
                    .with_context(|| format!("reading {}", path.display()))?,
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Every session kept, by item.
    pub fn all(&self) -> Result<BTreeMap<String, T>> {
        let mut all = BTreeMap::new();
        let Ok(packs) = std::fs::read_dir(&self.dir) else {
            return Ok(all);
        };
        for pack in packs {
            let pack = pack?;
            if !pack.file_type()?.is_dir() {
                continue;
            }
            for file in std::fs::read_dir(pack.path())? {
                let name = file?.file_name().to_string_lossy().into_owned();
                if let Some(item) = name.strip_suffix(".json") {
                    let key = format!("{}/{item}", pack.file_name().to_string_lossy());
                    if let Some(session) = self.get(&key)? {
                        all.insert(key, session);
                    }
                }
            }
        }
        Ok(all)
    }

    pub fn put(&self, key: &str, session: &T) -> Result<()> {
        let _guard = self.guard();
        self.write(key, session)
    }

    fn write(&self, key: &str, session: &T) -> Result<()> {
        let path = self.path(key)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(session)?;
        workshop_common::files::write_atomic(&path, json.as_bytes())
    }

    /// Changes a session, if there is one, returning what `change` does. The session is only
    /// saved if `change` succeeds.
    pub fn change<R>(
        &self,
        key: &str,
        change: impl FnOnce(&mut T) -> Result<R>,
    ) -> Result<Option<(T, R)>>
    where
        T: Clone,
    {
        let _guard = self.guard();
        let Some(mut session) = self.get(key)? else {
            return Ok(None);
        };
        let result = change(&mut session)?;
        self.write(key, &session)?;
        Ok(Some((session, result)))
    }

    /// Ends a session, once whatever it was for is recorded.
    pub fn remove(&self, key: &str) -> Result<()> {
        let _guard = self.guard();
        match std::fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_sessions_by_item() {
        let dir = tempfile::tempdir().unwrap();
        let saved: Saved<Vec<u32>> = Saved::new(dir.path().join("things"));
        assert_eq!(saved.get("sample/one").unwrap(), None);
        assert!(saved.all().unwrap().is_empty());
        saved.put("sample/one", &vec![1]).unwrap();
        saved.put("other/two-more", &vec![2]).unwrap();
        assert_eq!(saved.get("sample/one").unwrap(), Some(vec![1]));
        assert_eq!(saved.all().unwrap().len(), 2);

        let changed = saved
            .change("sample/one", |v| {
                v.push(5);
                Ok(v.len())
            })
            .unwrap();
        assert_eq!(changed, Some((vec![1, 5], 2)));
        // A change that fails isn't saved.
        let failed = saved.change::<()>("sample/one", |v| {
            v.clear();
            bail!("no")
        });
        assert!(failed.is_err());
        assert_eq!(saved.get("sample/one").unwrap(), Some(vec![1, 5]));
        assert_eq!(saved.change("sample/none", |_| Ok(())).unwrap(), None);

        saved.remove("sample/one").unwrap();
        saved.remove("sample/one").unwrap();
        assert_eq!(saved.get("sample/one").unwrap(), None);
    }

    #[test]
    fn refuses_keys_that_could_lead_outside_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let saved: Saved<u32> = Saved::new(dir.path().to_owned());
        for key in [
            "sample",
            "../x/y",
            "sample/../../y",
            "a/b/c",
            "/x",
            "Sample/x",
        ] {
            assert!(saved.put(key, &1).is_err(), "{key}");
        }
    }
}
