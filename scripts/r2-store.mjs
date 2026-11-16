// R2 桶直传（构建机 / 脚本用）：安装包、清单与清理都直接走 S3 API，文件本体不经服务器。
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

const CONTENT_TYPES = {
  exe: 'application/octet-stream',
  json: 'application/json',
  zip: 'application/zip',
}

/**
 * 未配置全部字段时返回 `{ enabled: false }`，调用方回退到管理网关。
 */
export function createR2Store({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return { enabled: false }

  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  return {
    enabled: true,

    /** 上传本地文件到 `key`；清单短缓存，其余 4 小时。 */
    async put(filePath, key) {
      const info = await stat(filePath)
      const ext = path.extname(filePath).slice(1).toLowerCase()
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: info.size,
          ContentType: CONTENT_TYPES[ext] || 'application/octet-stream',
          CacheControl: key.endsWith('.json') ? 'public, max-age=60' : 'public, max-age=14400',
        }),
      )
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },

    /** 列出前缀下的对象：`[{ name, size }]`（name 为完整 key）。 */
    async list(prefix) {
      const files = []
      let token
      do {
        const resp = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
        )
        for (const item of resp.Contents || []) files.push({ name: item.Key, size: item.Size })
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined
      } while (token)
      return files
    },
  }
}
