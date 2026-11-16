// 游戏 bundleVersion 解析与版本门控。
//
// 背景：mod 详情页要求游戏版本 ≥ 1.1.3。exe 文件版本只是 Unity 引擎版本，
// 真实版本号存于 Unity PlayerSettings 的 bundleVersion 字段：
// 标准安装位于 `SecretFlasherManaka_Data/globalgamemanagers`（未压缩 SerializedFile）；
// 市面流通的重打包版没有该文件，PlayerSettings 被合入 `data.unity3d`
// （UnityFS bundle，blocksInfo 用 LZMA 压缩，PlayerSettings 在首个 SerializedFile 开头）。
// 解析失败一律按 unknown（放行）处理——fail-open，避免误杀未来新版与未知改版。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

/// 允许打开 mod 详情页的最低游戏版本。
const MIN_REQUIRED: [u64; 3] = [1, 1, 3];

/// blocksInfo 解压后的尺寸上限 / 单个数据块解压上限 / 扫描累计解压上限（防御损坏文件）。
const BLOCKS_INFO_UNC_MAX: u32 = 8 << 20;
const BLOCK_UNC_MAX: u32 = 4 << 20;
const BLOCK_COMP_MAX: u32 = 16 << 20;
const SCAN_TOTAL_MAX: u64 = 32 << 20;

const COMPANY: &[u8] = b"SheableSoft";
const PRODUCT: &[u8] = b"SecretFlasherManaka";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBundleVersionResult {
    /// "ok"=版本达标放行 | "blocked"=低于要求 | "unknown"=无法判定（放行）
    pub status: String,
    /// 解析到的 bundleVersion（unknown 时为 None）
    pub version: Option<String>,
    /// 最低要求版本，前端文案插值用，避免双端硬编码漂移
    pub required: String,
}

fn version_str(v: [u64; 3]) -> String {
    format!("{}.{}.{}", v[0], v[1], v[2])
}

fn unknown(version: Option<String>) -> GameBundleVersionResult {
    GameBundleVersionResult { status: "unknown".into(), version, required: version_str(MIN_REQUIRED) }
}

/// 解析 "x.y[.z...]" 数字版本；任一字段非纯数字返回 None。缺位补 0。
fn parse_version(s: &str) -> Option<[u64; 3]> {
    let mut out = [0u64; 3];
    for (i, part) in s.split('.').enumerate() {
        if i >= 3 || part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[i] = part.parse::<u64>().ok()?;
    }
    Some(out)
}

/// 版本串 → 门控结论。解析不出（缺位/非数字）归 unknown 放行。
fn decide(version: Option<String>) -> GameBundleVersionResult {
    let required = version_str(MIN_REQUIRED);
    let Some(v) = version else {
        return GameBundleVersionResult { status: "unknown".into(), version: None, required };
    };
    match parse_version(&v) {
        Some(parsed) if parsed < MIN_REQUIRED => {
            log::info!("[game_version] 版本 {v} 低于 {required}，拦截");
            GameBundleVersionResult { status: "blocked".into(), version: Some(v), required }
        }
        Some(_) => GameBundleVersionResult { status: "ok".into(), version: Some(v), required },
        None => unknown(Some(v)),
    }
}

/// 读 bundleVersion 并映射为门控结果。
#[tauri::command]
pub fn check_game_bundle_version(app: tauri::AppHandle) -> GameBundleVersionResult {
    let game_path = match crate::db::subscribe::read_game_path(&app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[game_version] 读取 game_path 失败: {e}");
            return decide(None);
        }
    };
    let data_dir = Path::new(&game_path).join("SecretFlasherManaka_Data");
    decide(get_bundle_version(&data_dir))
}

fn get_bundle_version(data_dir: &Path) -> Option<String> {
    // 标准版式：globalgamemanagers 是未压缩 SerializedFile，直接扫前 8MB
    if let Some(v) = try_plain_file(&data_dir.join("globalgamemanagers")) {
        return Some(v);
    }
    // 重打包版式：data.unity3d（UnityFS v8）
    try_unityfs(&data_dir.join("data.unity3d"))
}

fn try_plain_file(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut buf = Vec::new();
    f.by_ref().take(8 << 20).read_to_end(&mut buf).ok()?;
    find_bundle_version_in(&buf)
}

// ── UnityFS ──────────────────────────────────────────────

const FLAG_COMPR_MASK: u32 = 0x3F;
const FLAG_BLOCKS_INFO_AT_END: u32 = 0x80;
const FLAG_PADDING_AT_START: u32 = 0x200;
const COMPR_NONE: u32 = 0;
const COMPR_LZMA: u32 = 1;
const COMPR_LZ4: u32 = 2; // LZ4 与 LZ4HC(3) 的裸 block 解压同算法

fn align16(pos: u64) -> u64 {
    (pos + 15) & !15
}

/// 读 BE u32 / BE i64 的小游标。
struct BeReader<'a> {
    buf: &'a [u8],
    pos: usize,
}
impl<'a> BeReader<'a> {
    fn u32(&mut self) -> Option<u32> {
        let b = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn i64(&mut self) -> Option<i64> {
        let b = self.buf.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(i64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn u16(&mut self) -> Option<u16> {
        let b = self.buf.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_be_bytes([b[0], b[1]]))
    }
    fn cstr(&mut self) -> Option<&'a [u8]> {
        let start = self.pos;
        let rel = self.buf[start..].iter().position(|c| *c == 0)?;
        self.pos = start + rel + 1;
        Some(&self.buf[start..start + rel])
    }
}

struct BlockInfo {
    uncompressed_size: u32,
    compressed_size: u32,
    flags: u16,
}

fn decompress(comp: u32, input: &[u8], out_size: usize) -> Option<Vec<u8>> {
    match comp {
        COMPR_NONE => {
            if input.len() < out_size {
                return None;
            }
            Some(input[..out_size].to_vec())
        }
        COMPR_LZMA => decompress_lzma(input, out_size),
        COMPR_LZ4 | 3 => lz4_flex::block::decompress(input, out_size).ok(),
        other => {
            log::warn!("[game_version] 不支持的压缩方式 {other}");
            None
        }
    }
}

/// Unity 裸 LZMA1：5 字节头（props u8 + dict_size u32 LE），无 8 字节解压长度、通常无 EOS 标志。
/// lzma-rs 的 UseProvided 分支与 Unity 头布局逐字节一致（同样先读 props 再读 dict，不读长度）。
fn decompress_lzma(input: &[u8], out_size: usize) -> Option<Vec<u8>> {
    use lzma_rs::decompress::{Options, UnpackedSize};
    let mut out = Vec::with_capacity(out_size);
    let mut cursor = std::io::Cursor::new(input);
    lzma_rs::lzma_decompress_with_options(
        &mut cursor,
        &mut out,
        &Options {
            unpacked_size: UnpackedSize::UseProvided(Some(out_size as u64)),
            memlimit: None,
            allow_incomplete: true,
        },
    )
    .ok()?;
    if out.len() == out_size {
        Some(out)
    } else {
        log::warn!("[game_version] LZMA 输出长度不符: {} != {}", out.len(), out_size);
        None
    }
}

fn try_unityfs(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let file_len = f.metadata().ok()?.len();

    let mut head = [0u8; 128];
    let n = f.read(&mut head).ok()?;
    let mut r = BeReader { buf: &head[..n], pos: 0 };
    if r.cstr()? != b"UnityFS" {
        return None;
    }
    let format_ver = r.u32()?;
    if !(6..=8).contains(&format_ver) {
        log::warn!("[game_version] 不支持的 UnityFS 版本 {format_ver}");
        return None;
    }
    let _unity_ver = r.cstr()?;
    let _engine_ver = r.cstr()?;
    let total_size = r.i64()?; // 解压后数据总长
    let comp_info_size = r.u32()? as u64; // blocksInfo 压缩长度
    let unc_info_size = r.u32()?; // blocksInfo 解压长度
    let flags = r.u32()?;
    if total_size < 0 || unc_info_size > BLOCKS_INFO_UNC_MAX {
        return None;
    }
    let header_end = align16(r.pos as u64); // format>=7 头部 16 对齐

    // blocksInfo 位置：默认在头后，BlocksInfoAtTheEnd 时在文件尾
    let bi_pos = if flags & FLAG_BLOCKS_INFO_AT_END != 0 {
        file_len.checked_sub(comp_info_size)?
    } else {
        header_end
    };
    let mut bi = vec![0u8; comp_info_size as usize];
    f.seek(SeekFrom::Start(bi_pos)).ok()?;
    f.read_exact(&mut bi).ok()?;
    let bi = decompress(flags & FLAG_COMPR_MASK, &bi, unc_info_size as usize)?;

    let mut r = BeReader { buf: &bi, pos: 0 };
    r.pos += 16; // uncompressedDataHash
    let block_count = r.u32()?; // int32；负数按无符号看会超限，由下方上限拦截
    if block_count == 0 || block_count > 2_000_000 {
        return None;
    }
    let mut blocks = Vec::new();
    for _ in 0..block_count {
        let uncompressed_size = r.u32()?;
        let compressed_size = r.u32()?;
        let flags = r.u16()?;
        if uncompressed_size > BLOCK_UNC_MAX || compressed_size > BLOCK_COMP_MAX {
            return None;
        }
        blocks.push(BlockInfo { uncompressed_size, compressed_size, flags });
    }
    // 其后是 node 表（path/offset 对扫描锚点启发式无用），不再解析。

    // 数据块起点：blocksInfo 在头后时跳到其末尾，再按 0x200 补零对齐
    let mut data_start = if flags & FLAG_BLOCKS_INFO_AT_END != 0 { header_end } else { header_end + comp_info_size };
    if flags & FLAG_PADDING_AT_START != 0 {
        data_start = align16(data_start);
    }

    // 顺序解压数据块并在每块上跑锚点启发式（PlayerSettings 在最前的 SerializedFile 开头）
    let mut scanned: u64 = 0;
    for block in blocks.iter().take(256) {
        if scanned >= SCAN_TOTAL_MAX {
            break;
        }
        let mut buf = vec![0u8; block.compressed_size as usize];
        f.seek(SeekFrom::Start(data_start)).ok()?;
        f.read_exact(&mut buf).ok()?;
        data_start += block.compressed_size as u64;
        scanned += block.compressed_size as u64;
        if let Some(out) = decompress((block.flags as u32) & FLAG_COMPR_MASK, &buf, block.uncompressed_size as usize) {
            if let Some(v) = find_bundle_version_in(&out) {
                return Some(v);
            }
        }
    }
    None
}

// ── 锚点启发式（两路径共用，不解析 TypeTree）──────────────
// 实证布局（v1.1.3 解压后 PlayerSettings 对象数据，相对对象起点）：
//   +40  [u32=11 LE]"SheableSoft"（companyName）
//   +56  [u32=19]"SecretFlasherManaka"（productName）
//   +565 [u32=3]"1.0"（visionOSBundleVersion）
//   +573 [u32=3]"1.0"（tvOSBundleVersion）
//   +581 [u32=5]"1.1.3"（bundleVersion = Application.version，本启发式目标）
// Unity 序列化字段顺序里 bundleVersion 紧跟在平台 BundleVersion（visionOS/tvOS，
// 常为默认"1.0"）之后、preloadedAssets 数组之前，三者是背靠背的字符串组
// （每个占 4+len 补齐 4 对齐）。因此取 productName 后「连续版本串组」的最后一个。
// 组内相邻前缀间距实测 8B；上限取 24B 容忍更长的平台版本值。

fn len_prefixed_eq(buf: &[u8], at: usize, s: &[u8]) -> bool {
    let len = s.len() as u32;
    let l = match buf.get(at..at + 4) {
        Some(b) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        None => return false,
    };
    l == len && buf.get(at + 4..at + 4 + s.len()) == Some(s)
}

/// buf[p..] 恰为「u32 长度（LE）+ 版本样式字符串 + 尾随 0x00」时返回 (p, 字符串)。
fn version_at(buf: &[u8], p: usize) -> Option<(usize, String)> {
    let b = buf.get(p..p + 4)?;
    let l = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
    if !(1..=64).contains(&l) {
        return None;
    }
    let s = buf.get(p + 4..p + 4 + l)?;
    if buf.get(p + 4 + l) != Some(&0) {
        return None;
    }
    let txt = std::str::from_utf8(s).ok()?;
    if looks_like_version(txt) {
        Some((p, txt.to_string()))
    } else {
        None
    }
}

/// [from, to) 内第一个版本串前缀位置。
fn next_version(buf: &[u8], from: usize, to: usize) -> Option<(usize, String)> {
    let end = buf.len().min(to);
    let mut p = from;
    while p + 5 <= end {
        if let Some(v) = version_at(buf, p) {
            return Some(v);
        }
        p += 1;
    }
    None
}

fn looks_like_version(s: &str) -> bool {
    let mut parts = s.split('.');
    let mut any = false;
    for p in parts.by_ref() {
        if p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()) {
            return false;
        }
        any = true;
    }
    any && s.contains('.')
}

fn find_bundle_version_in(buf: &[u8]) -> Option<String> {
    // 锚点：[u32=11 LE] + companyName，逐个尝试并验证 productName
    let mut start = 0usize;
    while let Some(rel) = find_subslice(&buf[start..], COMPANY) {
        let at = start + rel;
        start = at + COMPANY.len();
        if at < 4 || !len_prefixed_eq(buf, at - 4, COMPANY) {
            continue;
        }
        // companyName 值尾 4 字节对齐后即 productName 长度前缀
        let mut product_at = at + COMPANY.len();
        product_at = (product_at + 3) & !3;
        let mut found_product = false;
        for _ in 0..8 {
            if len_prefixed_eq(buf, product_at, PRODUCT) {
                found_product = true;
                break;
            }
            let l = match buf.get(product_at..product_at + 4) {
                Some(b) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize,
                None => break,
            };
            if l == 0 || l > 4096 {
                break;
            }
            product_at = product_at + 4 + l;
            product_at = (product_at + 3) & !3;
        }
        if !found_product {
            continue;
        }
        let after_product = product_at + 4 + PRODUCT.len();
        // 连续版本串组走到最后一个 = bundleVersion
        let (mut cur, mut cur_str) = next_version(buf, after_product, after_product + 2048)?;
        loop {
            match next_version(buf, cur + 4, cur + 24) {
                Some((np, ns)) if np - cur < 24 => {
                    cur = np;
                    cur_str = ns;
                }
                _ => break,
            }
        }
        return Some(cur_str);
    }
    None
}

fn find_subslice<'a>(haystack: &'a [u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── 测试 ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn push_lp(buf: &mut Vec<u8>, s: &[u8]) {
        buf.extend(&(s.len() as u32).to_le_bytes());
        buf.extend(s);
        let pad = (4 - (4 + s.len()) % 4) % 4;
        buf.extend(std::iter::repeat(0u8).take(pad));
    }

    /// 按实证布局构造 PlayerSettings 数据区（含 visionOS/tvOS 平台版本组）。
    fn synthetic(platforms: &[&str], version: &str, gap_len: usize) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&[0u8; 36]);
        push_lp(&mut buf, COMPANY); // [u32=11]"SheableSoft"
        push_lp(&mut buf, PRODUCT); // [u32=19]"SecretFlasherManaka"
        buf.extend_from_slice(&vec![0u8; gap_len]); // 定长数值字段区
        for p in platforms {
            push_lp(&mut buf, p.as_bytes()); // visionOS/tvOS BundleVersion
        }
        buf.extend(&(version.len() as u32).to_le_bytes());
        buf.extend_from_slice(version.as_bytes());
        buf.extend_from_slice(&[0u8; 3]);
        buf
    }

    #[test]
    fn finds_version_after_platform_run() {
        // 实测组：1.0,1.0,1.1.3（gap 520B ≈ 真实 525-5）
        let buf = synthetic(&["1.0", "1.0"], "1.1.3", 520);
        assert_eq!(find_bundle_version_in(&buf).as_deref(), Some("1.1.3"));
    }

    #[test]
    fn run_without_platform_versions_still_works() {
        let buf = synthetic(&[], "1.1.3", 520);
        assert_eq!(find_bundle_version_in(&buf).as_deref(), Some("1.1.3"));
    }

    #[test]
    fn finds_other_versions() {
        for v in ["1.0.0", "1.1.2", "1.1.10", "2.0.0"] {
            let buf = synthetic(&["1.0", "1.0"], v, 520);
            assert_eq!(find_bundle_version_in(&buf).as_deref(), Some(v), "version {v}");
        }
        // 平台版本被改高也不误取：仍返回最后一个
        let buf = synthetic(&["9.9", "8.8"], "1.0.5", 520);
        assert_eq!(find_bundle_version_in(&buf).as_deref(), Some("1.0.5"));
    }

    #[test]
    fn no_anchor_returns_none() {
        assert_eq!(find_bundle_version_in(&[7u8; 4096]), None);
        let mut buf = synthetic(&["1.0", "1.0"], "1.1.3", 520);
        // 破坏 companyName 长度前缀 → 锚点不成立
        let idx = buf.windows(COMPANY.len()).position(|w| w == COMPANY).unwrap();
        buf[idx - 4] = 12;
        assert_eq!(find_bundle_version_in(&buf), None);
    }

    #[test]
    fn version_comparison_is_numeric_not_lexical() {
        assert!(parse_version("1.1.2").unwrap() < MIN_REQUIRED);
        assert!(parse_version("1.0.9").unwrap() < MIN_REQUIRED);
        assert!(parse_version("1.1.3").unwrap() >= MIN_REQUIRED);
        assert!(parse_version("1.1.10").unwrap() > MIN_REQUIRED); // 字符串比较会误判
        assert!(parse_version("2.0").unwrap() > MIN_REQUIRED); // 缺位补 0
        assert_eq!(parse_version("1.1.3a"), None);
        assert_eq!(parse_version(""), None);
    }

    /// 目录不存在/没有可解析文件 → None，交给 decide 归 unknown 放行
    #[test]
    fn missing_data_dir_yields_no_version() {
        assert_eq!(get_bundle_version(Path::new("E:/sfmmm-gate-no-such-dir/SecretFlasherManaka_Data")), None);
    }

    #[test]
    fn decide_maps_version_to_gate_status() {
        assert_eq!(decide(Some("1.1.2".into())).status, "blocked");
        assert_eq!(decide(Some("1.0.9".into())).status, "blocked");
        assert_eq!(decide(Some("1.1.3".into())).status, "ok");
        assert_eq!(decide(Some("1.1.10".into())).status, "ok"); // 逐位比较，非字典序
        assert_eq!(decide(None).status, "unknown");
        let junk = decide(Some("nightly".into()));
        assert_eq!(junk.status, "unknown"); // 认不出的版本串放行
        assert_eq!(junk.version.as_deref(), Some("nightly"));
        assert_eq!(decide(Some("1.1.2".into())).required, "1.1.3");
    }

    /// 对本机真实游戏目录跑端到端解析：
    /// GAME_DIR=E:/pf/113 cargo test --lib -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_game_dir_parses_to_expected_version() {
        let dir = std::env::var("GAME_DIR").expect("需设置 GAME_DIR");
        let expected = std::env::var("EXPECT").unwrap_or_else(|_| "1.1.3".into());
        let got = get_bundle_version(&Path::new(&dir).join("SecretFlasherManaka_Data"));
        assert_eq!(got.as_deref(), Some(expected.as_str()), "GAME_DIR={dir}");
        // 门控结论须与「EXPECT 是否达标」一致（本机四目录均 1.1.3 → ok）
        let reach = parse_version(&expected).is_some_and(|p| p >= MIN_REQUIRED);
        assert_eq!(decide(got).status, if reach { "ok" } else { "blocked" }, "GAME_DIR={dir}");
    }
}
