    use super::*;

    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::io::{Read, Write};
    use std::path::Path;

    use sha2::{Digest, Sha256};
    use zip::write::SimpleFileOptions;
    use zip::{ZipArchive, ZipWriter};

    #[test]
    fn workspace_id_validation() {
        assert!(is_valid_workspace_id("12_zh_1700000000000_42"));
        assert!(!is_valid_workspace_id("../etc"));
        assert!(!is_valid_workspace_id("a/b"));
        assert!(!is_valid_workspace_id(""));
    }

    #[test]
    fn manifest_preserved_when_set_matches() {
        let original = r#"["b.json","a.txt"]"#;
        let paths = vec!["a.txt".to_string(), "b.json".to_string()];
        assert_eq!(resolve_manifest(original, &paths, true), original);
    }

    #[test]
    fn manifest_rebuilt_on_mismatch() {
        let paths = vec!["a.txt".to_string(), "b.json".to_string()];
        let rebuilt = resolve_manifest(r#"["x.txt"]"#, &paths, true);
        let parsed: Vec<String> = serde_json::from_str(&rebuilt).unwrap();
        assert_eq!(parsed, paths);
        let empty = resolve_manifest("", &paths, true);
        let parsed: Vec<String> = serde_json::from_str(&empty).unwrap();
        assert_eq!(parsed, paths);
    }

    #[test]
    fn hash_archive_keeps_same_basename_in_different_directories() {
        let make_zip = |files: &[(&str, &[u8])]| -> Vec<u8> {
            let mut buf: Vec<u8> = Vec::new();
            {
                let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buf));
                let options = SimpleFileOptions::default();
                for (name, content) in files {
                    writer.start_file(*name, options).unwrap();
                    writer.write_all(content).unwrap();
                }
                writer.finish().unwrap();
            }
            buf
        };
        let mut base = ZipArchive::new(std::io::Cursor::new(make_zip(&[
            ("config/a.json", b"one"),
            ("data/a.json", b"two"),
        ])))
        .unwrap();
        let mut new_pkg = ZipArchive::new(std::io::Cursor::new(make_zip(&[
            ("config/a.json", b"changed"),
            ("data/a.json", b"two"),
        ])))
        .unwrap();

        let mut base_name = HashMap::new();
        let mut base_path = HashMap::new();
        hash_archive(&mut base, "composite", "k", &mut base_name, &mut base_path, 0).unwrap();
        let mut new_name = HashMap::new();
        let mut new_path = HashMap::new();
        hash_archive(&mut new_pkg, "composite", "k", &mut new_name, &mut new_path, 0).unwrap();

        // basename 口径会把同名文件折叠成同一项（这正是旧实现漏判改动的原因）
        assert_eq!(base_name, new_name);
        // 路径口径能区分同名不同目录，变化必须被识别出来
        assert_ne!(base_path, new_path);

        // 写库格式（双键并存）：旧客户端仍能按 basename 命中，新读取端按路径精确命中
        let merged = crate::db::hash::merge_file_hashes(&base_name, &base_path);
        let json = serde_json::to_string(&merged).unwrap();
        let restored = crate::db::hash::parse_file_hashes_flat(Some(json.clone()));
        assert!(merged.contains_key("a.json"), "basename 键必须保留给旧客户端");
        // 旧客户端视角：扁平 string -> string，解析不失败
        let legacy_view: HashMap<String, String> = serde_json::from_str(&json).unwrap();
        assert!(!legacy_view.is_empty());
        match crate::db::hash::lookup_file_hash(&restored, "config/a.json", true) {
            crate::db::hash::HashLookup::Hit(h) => {
                assert_eq!(&h, base_path.get("config/a.json").unwrap())
            }
            _ => panic!("config/a.json 应按路径精确命中"),
        }
        match crate::db::hash::lookup_file_hash(&restored, "data/a.json", true) {
            crate::db::hash::HashLookup::Hit(h) => {
                assert_eq!(&h, base_path.get("data/a.json").unwrap())
            }
            _ => panic!("data/a.json 应按路径精确命中"),
        }
        assert!(detect_changed(
            &(base_name, Some(base_path)),
            &new_name,
            &new_path,
            false
        ));
    }

    #[test]
    fn manifest_collection_keeps_directory_entries() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut writer = ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = SimpleFileOptions::default();
            writer.add_directory("assets/", options).unwrap();
            writer.start_file("assets/a.txt", options).unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let mut archive = ZipArchive::new(std::io::Cursor::new(buf)).unwrap();
        let paths = collect_manifest_paths(&mut archive).unwrap();
        assert!(paths.contains(&"assets/".to_string()));
        assert!(paths.contains(&"assets/a.txt".to_string()));

        // 原 manifest 含目录条目时，集合一致 → 原样保留（目录集合不变）
        let original = r#"["assets/","assets/a.txt"]"#;
        assert_eq!(resolve_manifest(original, &paths, true), original);
    }

    #[test]
    fn manifest_rebuild_keeps_original_directories() {
        // zip 本身没有目录条目时，原清单里的目录项仍要保留，文件项按 zip 为准
        let paths = vec!["a.txt".to_string()];
        let rebuilt = resolve_manifest(r#"["old/","b.txt"]"#, &paths, true);
        let parsed: Vec<String> = serde_json::from_str(&rebuilt).unwrap();
        assert!(parsed.contains(&"a.txt".to_string()));
        assert!(parsed.contains(&"old/".to_string()));
        assert!(!parsed.contains(&"b.txt".to_string()));

        // 超长降级路径：不合并原目录条目，只保留传入的文件项
        let files_only = resolve_manifest(r#"["old/","b.txt"]"#, &paths, false);
        let parsed: Vec<String> = serde_json::from_str(&files_only).unwrap();
        assert_eq!(parsed, paths);
    }

    #[test]
    fn packaging_keeps_directories_and_manifest() {
        let dir = std::env::temp_dir().join(format!("sfmmm_edit_pkg_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.add_directory("assets/", options).unwrap();
            writer.start_file("assets/a.txt", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.start_file("root.txt", options).unwrap();
            writer.write_all(b"keep").unwrap();
            writer.finish().unwrap();
        }

        // 模拟一次选择性替换：assets/a.txt 换成新内容
        let staged_name = "stage_assets_a.bin";
        fs::write(dir.join("staging").join(staged_name), b"new").unwrap();
        let mut meta = WorkspaceMeta {
            workspace_id: "pkg_test".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "test_mod".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            manifest: r#"["assets/","assets/a.txt","root.txt"]"#.to_string(),
            ..Default::default()
        };
        meta.staged.insert(
            "assets/a.txt".to_string(),
            StagedMeta {
                staged_name: staged_name.to_string(),
                source_name: "a.txt".to_string(),
                source_path: String::new(),
                size: 3,
            },
        );

        let (_meta, built) = build_package_inner(&dir, meta).unwrap();

        // 写完的新包再解析：目录条目照旧保留，替换内容生效
        let mut archive =
            ZipArchive::new(fs::File::open(dir.join("package.zip")).unwrap()).unwrap();
        let paths = collect_manifest_paths(&mut archive).unwrap();
        assert!(paths.contains(&"assets/".to_string()));
        assert!(paths.contains(&"assets/a.txt".to_string()));
        assert!(paths.contains(&"root.txt".to_string()));

        // manifest 保留原清单里的目录条目（含只有空目录的分类目录），与库中原始清单一致
        assert_eq!(built.manifest, r#"["assets/","assets/a.txt","root.txt"]"#);
        assert!(!built.manifest_dirty);
        assert!(built.changed);

        let _ = fs::remove_dir_all(&dir);
    }

    fn sha256_bytes(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    #[test]
    fn manifest_normalization_keeps_directories() {
        let paths = normalized_manifest_paths(
            r#"["assets/","assets/a.txt","","/root.txt"]"#,
            "composite",
            "demo",
        )
        .unwrap();
        assert_eq!(paths, vec!["assets/", "assets/a.txt", "root.txt"]);
        let files =
            normalized_manifest_files(r#"["assets/","assets/a.txt"]"#, "composite", "demo")
                .unwrap();
        assert_eq!(files, vec!["assets/a.txt"]);
    }

    #[test]
    fn category_entry_paths_are_relative_to_install_target_dir() {
        // (category, raw 条目, 期望条目, 不允许出现的父级前缀)
        let cases = [
            ("dll", "BepInEx/plugins/sub/a.dll", "sub/a.dll", "BepInEx/plugins/"),
            ("v1", "CustomMissions/sub/a.bin", "sub/a.bin", "CustomMissions/"),
            (
                "v2",
                "CustomMissions2/demo/sub/a.bin",
                "sub/a.bin",
                "CustomMissions2/demo/",
            ),
            // composite 的安装落点就是游戏根，条目本来就相对游戏根，不允许改动
            (
                "composite",
                "BepInEx/plugins/a.dll",
                "BepInEx/plugins/a.dll",
                "",
            ),
        ];
        for (category, raw, expected, forbidden_prefix) in cases {
            assert_eq!(
                normalize_entry_path(category, "demo", raw),
                expected,
                "{category} 条目必须相对安装 target_dir"
            );
            if !forbidden_prefix.is_empty() {
                assert!(
                    !expected.to_lowercase().starts_with(&forbidden_prefix.to_lowercase()),
                    "{category} 条目不应带父级前缀: {expected}"
                );
            }
            // 大小写/反斜杠形式同样归一
            let upper = raw.to_uppercase().replace('/', "\\");
            if category != "composite" {
                assert_eq!(normalize_entry_path(category, "demo", &upper), expected.to_uppercase());
            }
            // 目录条目同样剥前缀并保留结尾斜杠
            let dir_raw = format!("{raw}/");
            let dir_expected = format!("{expected}/");
            assert_eq!(
                normalize_entry_path(category, "demo", &dir_raw),
                dir_expected
            );
            // manifest 与条目使用同一套归一规则
            let manifest = serde_json::to_string(&vec![raw.to_string()]).unwrap();
            let normalized = normalize_manifest(category, "demo", &manifest);
            let parsed: Vec<String> = serde_json::from_str(&normalized).unwrap();
            assert_eq!(parsed, vec![expected.to_string()]);
        }
        // 安装根目录条目本身（以及只含它的 manifest）应被丢弃，而不是留下父级目录
        let root_entries = [
            ("dll", "BepInEx/plugins/"),
            ("v1", "CustomMissions/"),
            ("v2", "CustomMissions2/demo/"),
        ];
        for (category, raw) in root_entries {
            assert_eq!(normalize_entry_path(category, "demo", raw), "");
            let manifest = serde_json::to_string(&vec![raw.to_string()]).unwrap();
            assert_eq!(normalize_manifest(category, "demo", &manifest), "[]");
        }
    }

    #[test]
    fn repeated_prefix_and_ancestor_dirs_normalize_to_stable_key() {
        // 截图场景：manifest 记录了 BepInEx/、BepInEx/plugins/ 和带父级前缀的文件。
        // 两个祖先目录必须被丢弃，文件必须归一成安装根相对键。
        let manifest = r#"["BepInEx/","BepInEx/plugins/","BepInEx/plugins/SfmPoC.dll"]"#;
        assert_eq!(
            normalized_manifest_paths(manifest, "dll", "demo").unwrap(),
            vec!["SfmPoC.dll"]
        );
        assert_eq!(
            normalized_manifest_files(manifest, "dll", "demo").unwrap(),
            vec!["SfmPoC.dll"]
        );

        // 前缀重复叠加 + 大小写/分隔符差异 + 已相对安装根的条目
        assert_eq!(
            normalize_entry_path("dll", "demo", r#"BepInEx\plugins\BepInEx\PLUGINS\sub\A.DLL"#),
            "sub/A.DLL"
        );
        assert_eq!(
            normalize_entry_path("dll", "demo", "sub/A.DLL"),
            "sub/A.DLL"
        );
        // 安装根的上级结构目录归一为空
        assert_eq!(normalize_entry_path("dll", "demo", "BepInEx/"), "");
        assert_eq!(normalize_entry_path("v2", "demo", "CustomMissions2/"), "");
        // 安装根本身（带不带结尾斜杠）也归一为空，不留下结构目录
        assert_eq!(normalize_entry_path("dll", "demo", "BepInEx/plugins"), "");
        assert_eq!(normalize_entry_path("dll", "demo", "BepInEx/plugins/"), "");
    }

    #[test]
    fn composite_manifest_keeps_game_relative_files_and_directories() {
        // 实际脏数据（mod_key=测试）：两条目录 + 两条文件。
        // composite 安装根是游戏根，文件路径必须原样保留，不能剥前缀；
        // BepInEx/、BepInEx/plugins/ 是合法的游戏相对目录条目，同样保留。
        let manifest = r#"["BepInEx/","BepInEx/plugins/","BepInEx/plugins/SfmPoC.dll","BepInEx/plugins/SfmPoC/MAP_DEV_GUIDE_EN.md"]"#;
        let parsed: Vec<String> =
            serde_json::from_str(&normalize_manifest("composite", "测试", manifest)).unwrap();
        assert_eq!(
            parsed,
            vec![
                "BepInEx/".to_string(),
                "BepInEx/plugins/".to_string(),
                "BepInEx/plugins/SfmPoC.dll".to_string(),
                "BepInEx/plugins/SfmPoC/MAP_DEV_GUIDE_EN.md".to_string(),
            ]
        );

        // dll：安装根是 BepInEx/plugins，前缀目录归一为空被丢弃
        let parsed: Vec<String> =
            serde_json::from_str(&normalize_manifest("dll", "测试", manifest)).unwrap();
        assert_eq!(
            parsed,
            vec!["SfmPoC.dll".to_string(), "SfmPoC/MAP_DEV_GUIDE_EN.md".to_string()]
        );
        assert_eq!(
            category_install_prefix("dll", "测试").as_deref(),
            Some("BepInEx/plugins")
        );

        // v2：中文 mod_key 参与前缀拼接，非 ASCII 不影响推导
        let v2 = r#"["CustomMissions2/测试/","CustomMissions2/测试/a.txt","b.txt"]"#;
        let parsed: Vec<String> =
            serde_json::from_str(&normalize_manifest("v2", "测试", v2)).unwrap();
        assert_eq!(parsed, vec!["a.txt".to_string(), "b.txt".to_string()]);

        // v1：安装根是 CustomMissions
        let v1 = r#"["CustomMissions/","CustomMissions/a.txt"]"#;
        let parsed: Vec<String> =
            serde_json::from_str(&normalize_manifest("v1", "测试", v1)).unwrap();
        assert_eq!(parsed, vec!["a.txt".to_string()]);
    }

    #[test]
    fn import_directory_matches_prefixed_manifest_with_install_root() {
        let base = std::env::temp_dir().join(format!("sfmmm_import_prefix_{}", now_millis()));
        let game = base.join("game");
        let plugins = game.join("BepInEx").join("plugins");
        let ws = base.join("ws");
        fs::create_dir_all(&plugins).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(plugins.join("SfmPoC.dll"), b"dll-bytes").unwrap();

        let meta = WorkspaceMeta {
            workspace_id: "import_prefix".to_string(),
            category: "dll".to_string(),
            mod_key: "demo".to_string(),
            manifest: r#"["BepInEx/","BepInEx/plugins/","BepInEx/plugins/SfmPoC.dll"]"#
                .to_string(),
            ..Default::default()
        };
        let (meta, summary) =
            import_directory_inner(&ws, meta, &plugins.to_string_lossy()).unwrap();
        // 上下两份列表按同一键解析：清单只剩 SfmPoC.dll，本地也命中同一个文件
        assert!(summary.missing.is_empty(), "不应再把带前缀条目判为缺失");
        assert!(summary.ambiguous.is_empty());
        assert_eq!(summary.total_manifest_files, 1);
        assert_eq!(summary.matched, 1);
        assert!(meta.staged.contains_key("SfmPoC.dll"));
        assert!(!meta.staged.contains_key("BepInEx/plugins/SfmPoC.dll"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn import_directory_falls_back_to_unique_basename_and_reports_ambiguity() {
        let base = std::env::temp_dir().join(format!("sfmmm_import_fallback_{}", now_millis()));
        let root = base.join("root");
        let ws = base.join("ws");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("a").join("only.dll"), b"only").unwrap();
        fs::write(root.join("a").join("dup.dll"), b"a").unwrap();
        fs::write(root.join("b").join("dup.dll"), b"b").unwrap();

        // 清单条目 sub/only.dll 在本地不存在，但 basename 唯一 → 兜底命中
        let meta = WorkspaceMeta {
            workspace_id: "fallback".to_string(),
            category: "v1".to_string(),
            mod_key: "demo".to_string(),
            manifest: r#"["sub/only.dll","sub/dup.dll"]"#.to_string(),
            ..Default::default()
        };
        let (meta, summary) =
            import_directory_inner(&ws, meta, &root.to_string_lossy()).unwrap();
        assert_eq!(summary.matched, 1, "unique basename 应兜底命中");
        assert!(meta.staged.contains_key("sub/only.dll"));
        // dup.dll 同名两份且后缀无法收窄 → 判为路径无法解析，不猜
        assert!(summary.missing.is_empty());
        assert_eq!(summary.ambiguous, vec!["sub/dup.dll".to_string()]);
        assert_eq!(summary.ambiguous_details.len(), 1);
        assert!(summary.ambiguous_details[0].contains("路径无法解析"));
        assert!(summary.ambiguous_details[0].contains("a/dup.dll"));
        assert!(summary.ambiguous_details[0].contains("b/dup.dll"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn normalize_meta_paths_remaps_sets_and_drops_stale_build() {
        let dir = std::env::temp_dir().join(format!("sfmmm_norm_ws_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        fs::write(dir.join("package.zip"), b"stale").unwrap();

        let mut meta = WorkspaceMeta {
            workspace_id: "norm_test".to_string(),
            category: "dll".to_string(),
            mod_key: "demo".to_string(),
            manifest: r#"["BepInEx/plugins/a.dll"]"#.to_string(),
            entries: vec![EntryMeta {
                index: 0,
                path: "BepInEx/plugins/a.dll".to_string(),
                size: 3,
            }],
            staged: HashMap::from([(
                "BepInEx/plugins/a.dll".to_string(),
                StagedMeta {
                    staged_name: "stage_a.bin".to_string(),
                    source_name: "a.dll".to_string(),
                    source_path: String::new(),
                    size: 3,
                },
            )]),
            selected: HashSet::from(["BepInEx/plugins/a.dll".to_string()]),
            excluded: HashSet::from(["BepInEx/plugins/old.dll".to_string()]),
            added: HashSet::from(["BepInEx/plugins/new.dll".to_string()]),
            built: Some(BuiltMeta::default()),
            ..Default::default()
        };

        assert!(normalize_meta_paths(&dir, &mut meta));
        assert_eq!(meta.entries[0].path, "a.dll");
        assert!(meta.staged.contains_key("a.dll"));
        assert!(!meta.staged.contains_key("BepInEx/plugins/a.dll"));
        assert!(meta.selected.contains("a.dll"));
        assert!(meta.excluded.contains("old.dll"));
        assert!(meta.added.contains("new.dll"));
        assert_eq!(meta.manifest, r#"["a.dll"]"#);
        // 带旧前缀的待发布包作废，避免把父级目录写进新包
        assert!(meta.built.is_none());
        assert!(!dir.join("package.zip").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn packaging_strips_category_root_prefix_from_zip_and_manifest() {
        let dir = std::env::temp_dir().join(format!("sfmmm_pkg_norm_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("BepInEx/plugins/a.dll", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.start_file("a.dll", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.finish().unwrap();
        }

        let staged_name = "stage_a.bin";
        fs::write(dir.join("staging").join(staged_name), b"new").unwrap();
        let mut meta = WorkspaceMeta {
            workspace_id: "pkg_norm".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "dll".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            // 工作区条目已按 load_meta 的规则归一
            manifest: r#"["a.dll"]"#.to_string(),
            ..Default::default()
        };
        meta.staged.insert(
            "a.dll".to_string(),
            StagedMeta {
                staged_name: staged_name.to_string(),
                source_name: "a.dll".to_string(),
                source_path: String::new(),
                size: 3,
            },
        );
        meta.selected.insert("a.dll".to_string());

        let (_meta, built) = build_package_inner(&dir, meta).unwrap();

        let mut archive =
            ZipArchive::new(fs::File::open(dir.join("package.zip")).unwrap()).unwrap();
        let paths = collect_manifest_paths(&mut archive).unwrap();
        assert_eq!(paths, vec!["a.dll".to_string()]);
        assert!(
            !paths.iter().any(|p| p.to_lowercase().starts_with("bepinex/")),
            "新包不应带 BepInEx/ 父级前缀: {paths:?}"
        );
        let manifest: Vec<String> = serde_json::from_str(&built.manifest).unwrap();
        assert_eq!(manifest, paths, "manifest 必须等于最终 zip 条目集合");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_directory_build_without_base_zip() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/keep.txt"), b"same").unwrap();
        fs::write(root.join("data/change.txt"), b"new").unwrap();

        let manifest = r#"["data/","data/keep.txt","data/change.txt"]"#;
        let baseline = serde_json::json!({
            "keep.txt": sha256_bytes(b"same"),
            "change.txt": sha256_bytes(b"old"),
        })
        .to_string();
        let meta = WorkspaceMeta {
            workspace_id: "local_test".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: manifest.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };

        let (meta, summary) =
            import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        assert_eq!(summary.changed, 1);
        assert_eq!(summary.unchanged, 1);
        assert!(summary.missing.is_empty());
        assert!(!summary.baseline_unverified);
        // 导入后「内容有变化」的条目必须自动进入 selected，UI 才会默认勾选
        assert!(meta.selected.contains("data/change.txt"));
        assert!(!meta.selected.contains("data/keep.txt"));
        assert!(meta.selection_initialized);

        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert!(built.changed);
        // 新包与清单都保留原清单的目录条目（data/ 即使只剩空目录也要写入）
        assert_eq!(
            built.manifest,
            r#"["data/","data/keep.txt","data/change.txt"]"#
        );

        let mut archive =
            ZipArchive::new(fs::File::open(ws.join("package.zip")).unwrap()).unwrap();
        let mut keep = String::new();
        archive
            .by_name("data/keep.txt")
            .unwrap()
            .read_to_string(&mut keep)
            .unwrap();
        assert_eq!(keep, "same");
        let mut changed = String::new();
        archive
            .by_name("data/change.txt")
            .unwrap()
            .read_to_string(&mut changed)
            .unwrap();
        assert_eq!(changed, "new");
        assert!(built.file_hashes.contains("keep.txt"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn local_directory_missing_entries_keep_base_content() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_missing_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_missing_ws_{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("a.txt"), b"a").unwrap();

        // 底包里有 a/b 的原始内容：本地缺 b.txt 且没选中替换时应保留底包原样
        let base_path = ws.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("a.txt", options).unwrap();
            writer.write_all(b"old-a").unwrap();
            writer.start_file("b.txt", options).unwrap();
            writer.write_all(b"old-b").unwrap();
            writer.finish().unwrap();
        }
        let base_hash = sha256_file(&base_path).unwrap();

        let meta = WorkspaceMeta {
            workspace_id: "local_missing".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt","b.txt"]"#.to_string(),
            base_file_hash: base_hash,
            ..Default::default()
        };
        let (meta, summary) =
            import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        assert_eq!(summary.missing, vec!["b.txt".to_string()]);
        // 本地缺失的 b.txt 不再阻断构建：回退到底包原内容
        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert!(built.changed);

        let mut archive =
            ZipArchive::new(fs::File::open(ws.join("package.zip")).unwrap()).unwrap();
        let mut a = String::new();
        archive.by_name("a.txt").unwrap().read_to_string(&mut a).unwrap();
        assert_eq!(a, "a");
        let mut b = String::new();
        archive.by_name("b.txt").unwrap().read_to_string(&mut b).unwrap();
        assert_eq!(b, "old-b");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn selected_missing_local_bytes_reports_entry_path() {
        let dir = std::env::temp_dir().join(format!("sfmmm_selected_missing_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        let mut meta = WorkspaceMeta {
            workspace_id: "selected_missing".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            local_source: Some(LocalSourceMeta::default()),
            ..Default::default()
        };
        // 选中替换，但暂存文件已被清掉：必须报错，并指出具体条目路径
        meta.staged.insert(
            "a.txt".to_string(),
            StagedMeta {
                staged_name: "missing.bin".to_string(),
                source_name: "a.txt".to_string(),
                source_path: String::new(),
                size: 0,
            },
        );
        meta.selected.insert("a.txt".to_string());

        let err = match build_from_local_source(&dir, meta) {
            Ok(_) => panic!("选中替换但本地字节缺失时不应打包成功"),
            Err(e) => e,
        };
        assert!(err.contains("a.txt"), "错误信息应包含条目路径：{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_apply_scans_local_dir_and_selects_changes() {
        // 游戏路径是唯一来源：composite 的根目录就是游戏根。
        let root = std::env::temp_dir().join(format!("sfmmm_auto_scan_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_auto_scan_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/keep.txt"), b"same").unwrap();
        fs::write(root.join("data/change.txt"), b"new").unwrap();

        let baseline = serde_json::json!({
            "keep.txt": sha256_bytes(b"same"),
            "change.txt": sha256_bytes(b"old"),
        })
        .to_string();
        let meta = WorkspaceMeta {
            workspace_id: "auto_scan".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "composite".to_string(),
            manifest: r#"["data/keep.txt","data/change.txt"]"#.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };

        let (meta, auto) =
            auto_apply_inner(&ws, meta, None, Ok(root.to_string_lossy().to_string())).unwrap();
        assert_eq!(auto.mode, "import");
        assert!(auto.applied >= 1);
        // 打开面板即按 hash 比对，变化条目自动勾选，未变条目不勾选
        assert!(meta.selected.contains("data/change.txt"));
        assert!(!meta.selected.contains("data/keep.txt"));
        assert!(meta.local_source.is_some());
        assert_eq!(meta.local_source.as_ref().unwrap().root_kind, "game_root");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn auto_apply_restores_remembered_source_files() {
        let ws = std::env::temp_dir().join(format!("sfmmm_auto_ws_{}", now_millis()));
        let src_root = std::env::temp_dir().join(format!("sfmmm_auto_src_{}", now_millis()));
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&src_root).unwrap();
        let src = src_root.join("remembered.txt");
        fs::write(&src, b"latest").unwrap();

        let mut meta = WorkspaceMeta {
            workspace_id: "auto_remembered".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "composite".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            // 已有一个新增条目时不重扫目录，走逐条 source_path 记忆兜底
            ..Default::default()
        };
        meta.added.insert("extra.txt".to_string());
        meta.staged.insert(
            "a.txt".to_string(),
            StagedMeta {
                staged_name: "stage_a.bin".to_string(),
                source_name: "remembered.txt".to_string(),
                source_path: src.to_string_lossy().to_string(),
                size: 3,
            },
        );

        let (meta, auto) =
            auto_apply_inner(&ws, meta, None, Ok(src_root.to_string_lossy().to_string())).unwrap();
        assert_eq!(auto.mode, "remembered");
        assert_eq!(auto.applied, 1);
        assert!(meta.selected.contains("a.txt"));
        assert!(meta.selection_initialized);
        let staged = ws
            .join("staging")
            .join(&meta.staged["a.txt"].staged_name);
        assert_eq!(fs::read(&staged).unwrap(), b"latest");

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&src_root);
    }

    #[test]
    fn derive_local_root_matches_install_target_dir() {
        // 根目录必须与 subscribe.rs 安装时的 target_dir 一致：
        // manifest 条目相对它记录，若再拼一次类别子目录就会整体错位。
        let game = std::env::temp_dir().join(format!("sfmmm_derive_game_{}", now_millis()));
        fs::create_dir_all(&game).unwrap();
        let g = game.to_string_lossy().to_string();

        assert_eq!(
            derive_local_root("composite", "demo", Some(&g)).unwrap().0,
            game
        );
        assert_eq!(
            derive_local_root("v1", "demo", Some(&g)).unwrap().0,
            game.join("CustomMissions")
        );
        assert_eq!(
            derive_local_root("v2", "demo", Some(&g)).unwrap().0,
            game.join("CustomMissions2").join("demo")
        );
        assert_eq!(
            derive_local_root("dll", "demo", Some(&g)).unwrap().0,
            game.join("BepInEx").join("plugins")
        );
        // 未配置游戏目录 / 非法模组标识都必须报错，不能静默返回空根
        assert!(derive_local_root("composite", "demo", None).is_err());
        assert!(derive_local_root("v2", "../evil", Some(&g)).is_err());

        let _ = fs::remove_dir_all(&game);
    }

    #[test]
    fn auto_apply_derives_v2_root_from_game_path_without_double_join() {
        // v2 安装到 <game>/CustomMissions2/<mod_key>，manifest 相对该目录。
        // 若实现又拼一次 CustomMissions2/<mod_key>，下面这个 mod.json 就永远找不到。
        let game = std::env::temp_dir().join(format!("sfmmm_auto_game_v2_{}", now_millis()));
        let mod_dir = game.join("CustomMissions2").join("demo");
        let ws = std::env::temp_dir().join(format!("sfmmm_auto_game_v2_ws_{}", now_millis()));
        fs::create_dir_all(&mod_dir).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(mod_dir.join("mod.json"), b"new").unwrap();
        let baseline = serde_json::json!({ "mod.json": sha256_bytes(b"old") }).to_string();

        let meta = WorkspaceMeta {
            workspace_id: "auto_game_v2".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["mod.json"]"#.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };

        let (meta, auto) =
            auto_apply_inner(&ws, meta, None, Ok(game.to_string_lossy().to_string())).unwrap();
        assert_eq!(auto.mode, "import");
        assert_eq!(auto.root_kind, "custom_missions2");
        assert_eq!(meta.local_source.as_ref().unwrap().root_path, mod_dir.to_string_lossy());
        assert_eq!(meta.local_source.as_ref().unwrap().root_kind, "custom_missions2");
        assert!(meta.selected.contains("mod.json"));
        assert!(meta.local_source.as_ref().unwrap().summary.missing.is_empty());
        // 期望根目录与实际根目录一致：只拼一次
        assert_eq!(
            meta.local_source.as_ref().unwrap().summary.expected_root,
            mod_dir.to_string_lossy()
        );

        let _ = fs::remove_dir_all(&game);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn auto_apply_derives_composite_root_from_game_path() {
        // composite 的 manifest 相对游戏根（含 BepInEx/...），不能再拼 CustomMissions
        let game = std::env::temp_dir().join(format!("sfmmm_auto_game_comp_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_auto_game_comp_ws_{}", now_millis()));
        fs::create_dir_all(game.join("BepInEx").join("plugins")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(game.join("BepInEx/plugins/foo.dll"), b"new").unwrap();
        let baseline = serde_json::json!({ "foo.dll": sha256_bytes(b"old") }).to_string();

        let meta = WorkspaceMeta {
            workspace_id: "auto_game_comp".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "composite".to_string(),
            manifest: r#"["BepInEx/plugins/foo.dll"]"#.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };

        let (meta, auto) =
            auto_apply_inner(&ws, meta, None, Ok(game.to_string_lossy().to_string())).unwrap();
        assert_eq!(auto.mode, "import");
        assert_eq!(auto.root_kind, "game_root");
        assert!(meta.selected.contains("BepInEx/plugins/foo.dll"));
        assert!(meta.local_source.as_ref().unwrap().summary.missing.is_empty());

        let _ = fs::remove_dir_all(&game);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn auto_apply_reports_explicit_error_without_game_path() {
        let ws = std::env::temp_dir().join(format!("sfmmm_auto_nogame_ws_{}", now_millis()));
        fs::create_dir_all(&ws).unwrap();
        let meta = WorkspaceMeta {
            workspace_id: "auto_nogame".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            ..Default::default()
        };

        let (_, auto) =
            auto_apply_inner(&ws, meta, None, Err("GAME_DIR_INVALID".to_string())).unwrap();
        assert_eq!(auto.mode, "error");
        assert_eq!(auto.error_code, "GAME_PATH_MISSING");
        assert!(auto.error.contains("设置"));

        // 游戏目录有效、但类别子目录不存在：也要说清楚应在哪一层查找
        let game = std::env::temp_dir().join(format!("sfmmm_auto_noroot_game_{}", now_millis()));
        fs::create_dir_all(&game).unwrap();
        let meta = WorkspaceMeta {
            workspace_id: "auto_noroot".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            ..Default::default()
        };
        let (_, auto) =
            auto_apply_inner(&ws, meta, None, Ok(game.to_string_lossy().to_string())).unwrap();
        assert_eq!(auto.mode, "error");
        assert_eq!(auto.error_code, "ROOT_MISSING");
        assert!(auto.error.contains("CustomMissions2"));
        assert!(auto.expected_root.contains("CustomMissions2"));

        let _ = fs::remove_dir_all(&game);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_only_walks_manifest_entries_not_whole_root() {
        // composite 的根是游戏根：只按清单条目定位文件，不能递归扫描游戏本体。
        let root = std::env::temp_dir().join(format!("sfmmm_entry_scan_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_entry_scan_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("SecretFlasherManaka_Data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/a.txt"), b"new").unwrap();
        // 游戏本体文件：不在清单里，也不能因为它被当成「来源超大/多余」
        fs::write(root.join("SecretFlasherManaka_Data/data.unity3d"), vec![0u8; 1024])
            .unwrap();
        fs::write(root.join("unrelated.bin"), b"x").unwrap();

        let meta = WorkspaceMeta {
            category: "composite".to_string(),
            manifest: r#"["data/a.txt","data/missing.txt"]"#.to_string(),
            ..Default::default()
        };
        let (_meta, summary) =
            import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        assert_eq!(summary.matched, 1);
        assert_eq!(summary.changed, 1);
        assert_eq!(summary.missing, vec!["data/missing.txt".to_string()]);
        assert!(summary.extra.is_empty(), "不应把游戏本体/无关文件算作多余");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn draft_segments_apply_at_build_time_only() {
        let ws = std::env::temp_dir().join(format!("sfmmm_draft_ws_{}", now_millis()));
        let src_a = std::env::temp_dir().join(format!("sfmmm_draft_a_{}", now_millis()));
        let src_c = std::env::temp_dir().join(format!("sfmmm_draft_c_{}", now_millis()));
        fs::create_dir_all(&ws).unwrap();
        fs::write(&src_a, b"new-a").unwrap();
        fs::write(&src_c, b"new-c").unwrap();

        let mut meta = WorkspaceMeta {
            workspace_id: "draft".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v1".to_string(),
            manifest: r#"["a.txt","b.txt"]"#.to_string(),
            entries: vec![
                EntryMeta { index: 0, path: "a.txt".to_string(), size: 3 },
                EntryMeta { index: 1, path: "b.txt".to_string(), size: 3 },
            ],
            ..Default::default()
        };
        let draft = DraftSegments {
            selected: vec!["a.txt".to_string()],
            excluded: vec!["b.txt".to_string()],
            replaced: vec![DraftFile {
                path: "a.txt".to_string(),
                source_path: src_a.to_string_lossy().to_string(),
            }],
            added: vec![DraftFile {
                path: "c.txt".to_string(),
                source_path: src_c.to_string_lossy().to_string(),
            }],
            staged_paths: None,
        };
        let duplicates = apply_draft_segments(&ws, &mut meta, &draft).unwrap();
        assert!(duplicates.is_empty());
        // 删除与勾选整体覆盖；新增条目追加进清单并标 added
        assert!(meta.selected.contains("a.txt"));
        assert!(!meta.selected.contains("b.txt"));
        assert!(meta.excluded.contains("b.txt"));
        assert!(meta.added.contains("c.txt"));
        assert!(meta.entries.iter().any(|e| e.path == "c.txt"));
        assert_eq!(meta.staged.len(), 2);
        let staged_a = ws.join("staging").join(&meta.staged["a.txt"].staged_name);
        assert_eq!(fs::read(staged_a).unwrap(), b"new-a");
        let staged_c = ws.join("staging").join(&meta.staged["c.txt"].staged_name);
        assert_eq!(fs::read(staged_c).unwrap(), b"new-c");

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_file(&src_a);
        let _ = fs::remove_file(&src_c);
    }

    #[test]
    fn view_reports_full_selection_for_uninitialized_old_draft() {
        // 旧草稿没有 selected 字段：后端按全选处理，前端必须拿到同样的集合
        let mut meta = WorkspaceMeta {
            workspace_id: "old".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            selection_initialized: false,
            ..Default::default()
        };
        meta.staged.insert(
            "a.txt".to_string(),
            StagedMeta {
                staged_name: "stage_a.bin".to_string(),
                source_name: "a.txt".to_string(),
                source_path: String::new(),
                size: 3,
            },
        );
        let v = view(&meta);
        assert_eq!(v["selection_initialized"], false);
        let selected = v["selected"].as_array().unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0], "a.txt");
    }

    #[test]
    fn removal_excludes_entry_from_manifest_and_hashes() {
        let dir = std::env::temp_dir().join(format!("sfmmm_edit_remove_{}", now_millis()));
        fs::create_dir_all(&dir).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("a.txt", options).unwrap();
            writer.write_all(b"a").unwrap();
            writer.start_file("b.txt", options).unwrap();
            writer.write_all(b"b").unwrap();
            writer.finish().unwrap();
        }
        let mut meta = WorkspaceMeta {
            workspace_id: "remove_test".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            manifest: r#"["a.txt","b.txt"]"#.to_string(),
            ..Default::default()
        };
        meta.excluded.insert("a.txt".to_string());

        let (_meta, built) = build_package_inner(&dir, meta).unwrap();
        assert!(built.changed);
        let parsed: Vec<String> = serde_json::from_str(&built.manifest).unwrap();
        assert_eq!(parsed, vec!["b.txt".to_string()]);
        assert!(!built.file_hashes.contains("a.txt"));
        assert!(built.file_hashes.contains("b.txt"));

        let mut archive =
            ZipArchive::new(fs::File::open(dir.join("package.zip")).unwrap()).unwrap();
        assert!(archive.by_name("a.txt").is_err());
        assert!(archive.by_name("b.txt").is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_all_entries_blocks_empty_package() {
        let dir = std::env::temp_dir().join(format!("sfmmm_edit_empty_{}", now_millis()));
        fs::create_dir_all(&dir).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("only.txt", options).unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let mut meta = WorkspaceMeta {
            workspace_id: "empty_test".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            manifest: r#"["only.txt"]"#.to_string(),
            ..Default::default()
        };
        meta.excluded.insert("only.txt".to_string());

        let err = match build_package_inner(&dir, meta) {
            Ok(_) => panic!("全部移除后不应生成空包"),
            Err(e) => e,
        };
        assert!(err.contains("没有任何文件"));
        assert!(!dir.join("package.zip").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_removal_drops_entry_from_manifest() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_rm_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_rm_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/keep.txt"), b"same").unwrap();
        fs::write(root.join("data/change.txt"), b"new").unwrap();

        let manifest = r#"["data/","data/keep.txt","data/change.txt"]"#;
        let baseline = serde_json::json!({
            "keep.txt": sha256_bytes(b"same"),
            "change.txt": sha256_bytes(b"old"),
        })
        .to_string();
        let meta = WorkspaceMeta {
            workspace_id: "local_rm".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: manifest.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };
        let (mut meta, _) = import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        meta.excluded.insert("data/change.txt".to_string());

        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert!(built.changed);
        let parsed: Vec<String> = serde_json::from_str(&built.manifest).unwrap();
        assert_eq!(parsed, vec!["data/".to_string(), "data/keep.txt".to_string()]);
        assert!(!built.file_hashes.contains("change.txt"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unselected_staged_entry_restores_base_bytes() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_unsel_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_unsel_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/keep.txt"), b"same").unwrap();
        fs::write(root.join("data/change.txt"), b"new").unwrap();

        let manifest = r#"["data/","data/keep.txt","data/change.txt"]"#;
        let baseline = serde_json::json!({
            "keep.txt": sha256_bytes(b"same"),
            "change.txt": sha256_bytes(b"old"),
        })
        .to_string();
        let meta = WorkspaceMeta {
            workspace_id: "local_unsel".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: manifest.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };
        let (mut meta, summary) =
            import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        assert_eq!(summary.changed, 1);

        // 准备底包：change.txt 的基线内容是 "old"
        let base_path = ws.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.add_directory("data/", options).unwrap();
            writer.start_file("data/keep.txt", options).unwrap();
            writer.write_all(b"same").unwrap();
            writer.start_file("data/change.txt", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.finish().unwrap();
        }
        meta.base_file_hash = sha256_file(&base_path).unwrap();
        // 取消勾选 change.txt：本次更新不采用本地新内容
        meta.selected.remove("data/change.txt");
        assert!(meta.selection_initialized);

        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert_eq!(built.replaced, 0);
        assert!(!built.changed);

        let mut archive =
            ZipArchive::new(fs::File::open(ws.join("package.zip")).unwrap()).unwrap();
        let mut restored = String::new();
        archive
            .by_name("data/change.txt")
            .unwrap()
            .read_to_string(&mut restored)
            .unwrap();
        assert_eq!(restored, "old");
        let mut keep = String::new();
        archive
            .by_name("data/keep.txt")
            .unwrap()
            .read_to_string(&mut keep)
            .unwrap();
        assert_eq!(keep, "same");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unselected_local_entry_requires_base_zip() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_nobase_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_nobase_ws_{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("a.txt"), b"new").unwrap();

        let baseline = serde_json::json!({ "a.txt": sha256_bytes(b"old") }).to_string();
        let meta = WorkspaceMeta {
            workspace_id: "local_nobase".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };
        let (mut meta, _) = import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        meta.selected.clear();

        let err = match build_from_local_source(&ws, meta) {
            Ok(_) => panic!("缺少底包时不应打包成功"),
            Err(e) => e,
        };
        assert!(err.contains("底包"), "错误信息应说明需要底包：{err}");
        assert!(!ws.join("package.zip").exists());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unselected_staged_entry_keeps_base_content() {
        // 底包路径：未勾选的 staged 条目原样透传，其余条目不受影响
        let dir = std::env::temp_dir().join(format!("sfmmm_edit_unsel_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("a.txt", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.finish().unwrap();
        }
        let staged_name = "stage_a.bin";
        fs::write(dir.join("staging").join(staged_name), b"new").unwrap();
        let mut meta = WorkspaceMeta {
            workspace_id: "unsel_test".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            manifest: r#"["a.txt"]"#.to_string(),
            ..Default::default()
        };
        meta.staged.insert(
            "a.txt".to_string(),
            StagedMeta {
                staged_name: staged_name.to_string(),
                source_name: "a.txt".to_string(),
                source_path: String::new(),
                size: 3,
            },
        );
        // 旧草稿迁移：未初始化时视为全选
        assert!(selected_paths(&meta).contains("a.txt"));

        meta.selection_initialized = true;
        meta.selected.clear();
        let (_meta, built) = build_package_inner(&dir, meta).unwrap();
        assert_eq!(built.replaced, 0);
        assert!(!built.changed);
        let mut archive =
            ZipArchive::new(fs::File::open(dir.join("package.zip")).unwrap()).unwrap();
        let mut content = String::new();
        archive
            .by_name("a.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "old");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn added_entry_target_follows_category_rules() {
        let dll = WorkspaceMeta {
            category: "dll".to_string(),
            ..Default::default()
        };
        assert_eq!(
            added_entry_target(&dll, Path::new("C:/build/Plugins/Extra.dll"), None).unwrap(),
            "Extra.dll"
        );

        let v1 = WorkspaceMeta {
            category: "v1".to_string(),
            ..Default::default()
        };
        let game = Path::new("C:/game");
        assert_eq!(
            added_entry_target(&v1, Path::new("C:/game/CustomMissions/sub/a.json"), Some(game))
                .unwrap(),
            "sub/a.json"
        );
        assert!(added_entry_target(&v1, Path::new("C:/other/a.json"), Some(game)).is_err());

        let composite = WorkspaceMeta {
            category: "composite".to_string(),
            ..Default::default()
        };
        assert_eq!(
            added_entry_target(&composite, Path::new("C:/game/BepInEx/x.dll"), Some(game)).unwrap(),
            "BepInEx/x.dll"
        );

        let v2 = WorkspaceMeta {
            category: "v2".to_string(),
            local_source: Some(LocalSourceMeta {
                root_path: "C:/mod".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            added_entry_target(&v2, Path::new("C:/mod/sub/y.bin"), None).unwrap(),
            "sub/y.bin"
        );

        // 没有 local_source 时按游戏目录推导 CustomMissions2/<mod_key>，
        // 相减后不能再残留类别子目录（否则等于拼了两次）。
        let v2_from_game = WorkspaceMeta {
            category: "v2".to_string(),
            mod_key: "demo".to_string(),
            ..Default::default()
        };
        assert_eq!(
            added_entry_target(
                &v2_from_game,
                Path::new("C:/game/CustomMissions2/demo/sub/y.bin"),
                Some(game)
            )
            .unwrap(),
            "sub/y.bin"
        );
        assert!(added_entry_target(
            &v2_from_game,
            Path::new("C:/game/sub/y.bin"),
            Some(game)
        )
        .is_err());
    }

    #[test]
    fn added_entry_is_packed_and_marks_change() {
        let dir = std::env::temp_dir().join(format!("sfmmm_edit_add_base_{}", now_millis()));
        fs::create_dir_all(dir.join("staging")).unwrap();
        let base_path = dir.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.start_file("a.txt", options).unwrap();
            writer.write_all(b"old").unwrap();
            writer.finish().unwrap();
        }
        fs::write(dir.join("staging").join("stage_new.bin"), b"fresh").unwrap();
        let mut meta = WorkspaceMeta {
            workspace_id: "add_base".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            base_file_hash: sha256_file(&base_path).unwrap(),
            manifest: r#"["a.txt"]"#.to_string(),
            selection_initialized: true,
            ..Default::default()
        };
        meta.entries.push(EntryMeta {
            index: 0,
            path: "a.txt".to_string(),
            size: 3,
        });
        meta.entries.push(EntryMeta {
            index: 1,
            path: "new.txt".to_string(),
            size: 5,
        });
        meta.added.insert("new.txt".to_string());
        meta.selected.insert("new.txt".to_string());
        meta.staged.insert(
            "new.txt".to_string(),
            StagedMeta {
                staged_name: "stage_new.bin".to_string(),
                source_name: "new.txt".to_string(),
                source_path: String::new(),
                size: 5,
            },
        );

        let (_meta, built) = build_package_inner(&dir, meta).unwrap();
        assert_eq!(built.added, 1);
        assert_eq!(built.replaced, 0);
        assert!(built.changed);
        assert!(built.file_hashes.contains("new.txt"));
        assert!(built.manifest.contains("new.txt"));

        let mut archive =
            ZipArchive::new(fs::File::open(dir.join("package.zip")).unwrap()).unwrap();
        let mut content = String::new();
        archive
            .by_name("new.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "fresh");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn added_entry_is_packed_in_local_mode() {
        let root = std::env::temp_dir().join(format!("sfmmm_local_add_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_local_add_ws_{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(ws.join("staging")).unwrap();
        fs::write(root.join("a.txt"), b"same").unwrap();
        let baseline = serde_json::json!({ "a.txt": sha256_bytes(b"same") }).to_string();
        let meta = WorkspaceMeta {
            workspace_id: "local_add".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: r#"["a.txt"]"#.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };
        let (mut meta, summary) =
            import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();
        assert_eq!(summary.changed, 0);

        fs::write(ws.join("staging").join("stage_add.bin"), b"fresh").unwrap();
        meta.entries.push(EntryMeta {
            index: 1,
            path: "b.txt".to_string(),
            size: 5,
        });
        meta.added.insert("b.txt".to_string());
        meta.selected.insert("b.txt".to_string());
        meta.selection_initialized = true;
        meta.staged.insert(
            "b.txt".to_string(),
            StagedMeta {
                staged_name: "stage_add.bin".to_string(),
                source_name: "b.txt".to_string(),
                source_path: String::new(),
                size: 5,
            },
        );

        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert_eq!(built.added, 1);
        assert!(built.changed);
        let mut archive =
            ZipArchive::new(fs::File::open(ws.join("package.zip")).unwrap()).unwrap();
        let mut content = String::new();
        archive
            .by_name("b.txt")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "fresh");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn publish_retry_only_for_transient_db_errors() {
        for e in [
            "[DBERR:POOL_BUSY] 连接池繁忙",
            "[DBERR:QUEUE_TIMEOUT] 排队超时",
            "[DBERR:QUERY_TIMEOUT] 执行超时",
            "[DBERR:TOO_MANY_CONNECTIONS] 连接数已达上限",
            "[DBERR:NETWORK] 网络读写中断",
            "[DBERR:DEADLOCK] 服务器返回错误码 1213（死锁）",
        ] {
            assert!(is_retryable_publish_error(e), "应可重试: {e}");
        }
        for e in [
            "[FORBIDDEN] 没有该语言的文件编辑权限",
            "[CONFLICT] 文件记录已被其他窗口更新",
            "VERSION_INVALID",
            "内容有变化，版本必须高于当前版本 v1.0.0",
        ] {
            assert!(!is_retryable_publish_error(e), "不应重试: {e}");
        }
    }

    #[test]
    fn publish_op_id_is_stable_per_content() {
        assert_eq!(publish_op_id("ws1", "hash-a"), publish_op_id("ws1", "hash-a"));
        assert_ne!(publish_op_id("ws1", "hash-a"), publish_op_id("ws1", "hash-b"));
        assert_ne!(publish_op_id("ws1", "hash-a"), publish_op_id("ws2", "hash-a"));
        assert_eq!(publish_op_id("ws1", "hash-a").len(), 64);
    }

    #[test]
    fn unselected_entry_restores_bytes_from_prefixed_base() {
        // 旧包条目名还带安装根前缀（CustomMissions2/demo/...）：按归一化路径
        // 取底包字节时必须能命中原始条目，否则「取消勾选」会报找不到条目。
        let root = std::env::temp_dir().join(format!("sfmmm_prefixed_src_{}", now_millis()));
        let ws = std::env::temp_dir().join(format!("sfmmm_prefixed_ws_{}", now_millis()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(root.join("data/keep.txt"), b"same").unwrap();
        fs::write(root.join("data/change.txt"), b"new").unwrap();

        let manifest = r#"["data/","data/keep.txt","data/change.txt"]"#;
        let baseline = serde_json::json!({
            "keep.txt": sha256_bytes(b"same"),
            "change.txt": sha256_bytes(b"old"),
        })
        .to_string();
        let meta = WorkspaceMeta {
            workspace_id: "prefixed_local".to_string(),
            mod_id: 1,
            lang_code: "zh".to_string(),
            mod_key: "demo".to_string(),
            category: "v2".to_string(),
            manifest: manifest.to_string(),
            base_file_hashes: baseline,
            ..Default::default()
        };
        let (mut meta, _) = import_directory_inner(&ws, meta, root.to_str().unwrap()).unwrap();

        // 底包沿用历史形态：条目名带 CustomMissions2/demo/ 前缀
        let base_path = ws.join("base.zip");
        {
            let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
            let options = SimpleFileOptions::default();
            writer.add_directory("CustomMissions2/demo/data/", options).unwrap();
            writer
                .start_file("CustomMissions2/demo/data/keep.txt", options)
                .unwrap();
            writer.write_all(b"same").unwrap();
            writer
                .start_file("CustomMissions2/demo/data/change.txt", options)
                .unwrap();
            writer.write_all(b"old").unwrap();
            writer.finish().unwrap();
        }
        meta.base_file_hash = sha256_file(&base_path).unwrap();
        meta.selected.remove("data/change.txt");
        assert!(meta.selection_initialized);

        let (_meta, built) = build_from_local_source(&ws, meta).unwrap();
        assert_eq!(built.replaced, 0);
        assert!(!built.changed);
        // 底包条目未归一：发布端必须连包一起重打，不能只改清单
        assert!(!built.base_paths_normalized);

        let mut archive =
            ZipArchive::new(fs::File::open(ws.join("package.zip")).unwrap()).unwrap();
        let mut restored = String::new();
        archive
            .by_name("data/change.txt")
            .unwrap()
            .read_to_string(&mut restored)
            .unwrap();
        assert_eq!(restored, "old");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn packaging_flags_unnormalized_base_entries() {
        // 底包条目已归一 → 允许「只改清单」；带前缀 → 必须重打包
        for (raw_entry, expected) in [("a.dll", true), ("BepInEx/plugins/a.dll", false)] {
            let dir = std::env::temp_dir().join(format!(
                "sfmmm_pkg_flag_{}_{}",
                expected,
                now_millis()
            ));
            fs::create_dir_all(dir.join("staging")).unwrap();
            let base_path = dir.join("base.zip");
            {
                let mut writer = ZipWriter::new(fs::File::create(&base_path).unwrap());
                let options = SimpleFileOptions::default();
                writer.start_file(raw_entry, options).unwrap();
                writer.write_all(b"payload").unwrap();
                writer.finish().unwrap();
            }
            let meta = WorkspaceMeta {
                workspace_id: "pkg_flag".to_string(),
                mod_id: 1,
                lang_code: "zh".to_string(),
                mod_key: "demo".to_string(),
                category: "dll".to_string(),
                base_file_hash: sha256_file(&base_path).unwrap(),
                manifest: r#"["a.dll"]"#.to_string(),
                ..Default::default()
            };
            let (_meta, built) = build_package_inner(&dir, meta).unwrap();
            assert_eq!(
                built.base_paths_normalized, expected,
                "底包条目 {raw_entry} 的归一判定错误"
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn manifest_only_repair_is_rejected_for_prefixed_manifest() {
        // 清单里文件名已归一（可能只差目录条目）→ 只改清单安全
        assert!(manifest_file_paths_normalized(
            "dll",
            "demo",
            r#"["BepInEx/","a.dll"]"#
        ));
        // 清单里文件名还带安装根前缀 → 包内条目大概率同样没归一，不能只改清单
        assert!(!manifest_file_paths_normalized(
            "dll",
            "demo",
            r#"["BepInEx/plugins/a.dll"]"#
        ));
    }
