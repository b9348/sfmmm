---
name: fix-latest-manifest
description: 修复图床版本清单 latest.json 404/被改名的问题。当用户反馈 app「检查更新」报"检测失败：Failed to fetch"，或发版后固定清单 URL 返回 404 时使用。根因通常是 Cloudflare Workers KV delete 配额耗尽导致图床"删旧传新"流程静默失败、文件被重命名为 latest(N).json。
---

# 修复图床 latest.json 版本清单

## 背景

- 应用更新检测的清单 URL 固定为 `${IMGBED_URL}/file/sfm/installer/latest.json`，`IMGBED_URL` 与 `IMGBED_TOKEN` 存在 `src-tauri/.env`（勿打印 token、勿提交该文件）。
- CI（`.github/workflows/release.yml` 的 "Upload to ImgBed & Update Cloud Version" 步骤）发版时先 delete 旧清单再以 `uploadNameType=origin` 重新上传。
- **关键陷阱 1**：ImgBed 的 delete 接口在 KV delete 配额耗尽（HTTP 429）时**仍返回 `{"success":true,...}`**，属于静默失败。唯一可靠的验证方式：上传同名文件后检查返回的 `src` 是否被重命名（如 `latest(1).json`）。
- **关键陷阱 2**：`uploadNameType=origin` 按**本地文件的原始文件名**保存。本地临时文件必须命名为 `latest.json`，否则会以错误名字上传（如 `latest_backup.json`）。

## 诊断

```bash
# 0. 读取图床地址（域名不写死在文档里）
IMGBED_URL=$(grep -E '^IMGBED_URL=' src-tauri/.env | cut -d= -f2- | tr -d '\r')

# 1. 固定 URL 是否 404（404 时响应体是 JPEG 占位图属正常现象）
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$IMGBED_URL/file/sfm/installer/latest.json"

# 2. 探测是否被重命名（N 从 1 往上试）
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$IMGBED_URL/file/sfm/installer/latest(1).json"

# 3. 查最近发版日志中 "Manifest upload response" 一行的 src 实际是什么
gh run list --repo b9348/sfmmm --workflow release.yml --limit 5 --json databaseId,conclusion,createdAt
gh run view <run-id> --repo b9348/sfmmm --log | grep -E "Manifest upload response|Download URL"
```

## 修复流程

```bash
# 读取配置（不回显 token）
IMGBED_URL=$(grep -E '^IMGBED_URL=' src-tauri/.env | cut -d= -f2- | tr -d '\r')
TOKEN=$(grep -E '^IMGBED_TOKEN=' src-tauri/.env | cut -d= -f2- | tr -d '\r')

# 1. 备份现存有效清单（通常在 latest(N).json 上；内容应含最新 version 和 update_url）
curl -s "$IMGBED_URL/file/sfm/installer/latest(1).json" -o /tmp/latest.json
cat /tmp/latest.json   # 确认内容正确，或按 GitHub Release 手工构造：
#   echo "{\"version\":\"X.Y.Z\",\"update_url\":\"<exe 直链>\"}" > /tmp/latest.json

# 2. 删除所有残留记录（旧 404 记录 + latest(N).json 全部）
curl -s -X GET "$IMGBED_URL/api/manage/delete/sfm/installer/latest.json" -H "Authorization: Bearer $TOKEN"
curl -s -X GET "$IMGBED_URL/api/manage/delete/sfm/installer/latest(1).json" -H "Authorization: Bearer $TOKEN"

# 3. 以固定名 latest.json 重新上传（本地文件名必须是 latest.json）
curl -s -X POST "$IMGBED_URL/upload?uploadChannel=telegram&uploadFolder=sfm/installer&returnFormat=full&uploadNameType=origin" \
  -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/latest.json"

# 4. 验证：返回 src 必须精确等于 $IMGBED_URL/file/sfm/installer/latest.json（无 (1) 后缀）
#    若仍被重命名 → KV delete 配额尚未重置，等 UTC 零点后重试
curl -s -w "\nHTTP %{http_code}\n" "$IMGBED_URL/file/sfm/installer/latest.json"
```

## 验收标准

- `${IMGBED_URL}/file/sfm/installer/latest.json` 返回 200，`version` 与 `update_url` 指向当前最新 Release 的 exe 直链。
- 所有 `latest(N).json` 残留均为 404。
- 修复后无需重新发版；app 端检测走 Rust reqwest（无缓存），前端回退 fetch 带 `no-store`，立即生效。
