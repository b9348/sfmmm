//! 7z 安全解压。
//!
//! `sevenz-rust` 0.6.1 的 `decompress_file` 直接把 `entry.name()` join 到目标目录，
//! 不校验 `..`、绝对路径或盘符（RUSTSEC-2026-0245），恶意归档可以写到解压目录之外。
//! 上游已停止维护，没有修复版本，因此这里改用 `decompress_file_with_extract_fn`，
//! 在写盘前用与 zip 解压同一套 [`crate::db::subscribe::safe_zip_path`] 规则校验条目路径，
//! 并自行创建普通文件（不创建符号链接、不继承归档里的权限位）。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use sevenz_rust::{decompress_file_with_extract_fn, Error, SevenZArchiveEntry};

/// 把 7z 解压到 `dest`。任何逃出 `dest` 的条目都会中止解压并返回错误。
pub fn extract_safely(src: &Path, dest: &Path) -> Result<(), String> {
    let root = dest.to_path_buf();
    let root_for_cb = root.clone();
    decompress_file_with_extract_fn(src, &root, move |entry, reader, _dest_path| {
        // 不信任 sevenz-rust 预先 join 出来的 _dest_path，按条目原始名字重新校验。
        let out = safe_entry_path(&root_for_cb, entry)?;
        if entry.is_directory() {
            fs::create_dir_all(&out).map_err(Error::io)?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(Error::io)?;
            }
            let mut file = fs::File::create(&out).map_err(Error::io)?;
            // 只写实际解压出的字节；不按 entry.size() 预分配，避免恶意声明触发 OOM。
            io::copy(reader, &mut file).map_err(Error::io)?;
            file.flush().map_err(Error::io)?;
        }
        Ok(true)
    })
    .map_err(|e| format!("解压 7z 失败: {e}"))
}

/// 把条目名转成 `root` 下的安全路径。
fn safe_entry_path(root: &Path, entry: &SevenZArchiveEntry) -> Result<PathBuf, Error> {
    safe_join(root, entry.name()).map_err(Error::other)
}

fn safe_join(root: &Path, name: &str) -> Result<PathBuf, String> {
    let rel = crate::db::subscribe::safe_zip_path(name)?;
    Ok(root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

#[cfg(test)]
mod tests {
    use super::safe_join;
    use std::path::Path;

    fn root() -> &'static Path {
        Path::new("game-root")
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(safe_join(root(), "../evil.dll").is_err());
        assert!(safe_join(root(), "a/../../evil.dll").is_err());
        assert!(safe_join(root(), "a\\..\\evil.dll").is_err());
        assert!(safe_join(root(), "a/.. /evil.dll").is_err());
        assert!(safe_join(root(), "./../evil.dll").is_err());
        assert!(safe_join(root(), "C:\\Windows\\evil.dll").is_err());
        assert!(safe_join(root(), "a/b:c").is_err());
        assert!(safe_join(root(), "").is_err());
    }

    #[test]
    fn keeps_normal_paths_under_root() {
        for name in [
            "BepInEx/plugins/a.dll",
            "a\\b\\c.txt",
            "./a/b.txt",
            "/etc/passwd",
        ] {
            let p = safe_join(root(), name).unwrap();
            assert!(p.starts_with(root()), "{name} -> {}", p.display());
        }
    }

    #[test]
    fn extract_safely_rejects_traversal_entry() {
        let base = std::env::temp_dir().join(format!(
            "sfmmm-sevenz-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let payload = base.join("payload.txt");
        std::fs::write(&payload, b"pwned").unwrap();
        let archive = base.join("evil.7z");
        {
            let mut writer = sevenz_rust::SevenZWriter::create(&archive).unwrap();
            let entry =
                sevenz_rust::SevenZArchiveEntry::from_path(&payload, "../escaped.txt".into());
            writer
                .push_archive_entry(entry, Some(std::fs::File::open(&payload).unwrap()))
                .unwrap();
            writer.finish().unwrap();
        }

        let dest = base.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let result = super::extract_safely(&archive, &dest);

        assert!(result.is_err(), "应拒绝包含 ../ 的 7z 条目");
        assert!(!base.join("escaped.txt").exists(), "不得写到目标目录之外");
        let _ = std::fs::remove_dir_all(&base);
    }
}
