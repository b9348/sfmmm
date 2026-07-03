import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  makeStyles,
  Text,
  Card,
  CardHeader,
  CardPreview,
  Badge,
} from '@fluentui/react-components'
import {
  CheckmarkCircle24Filled,
  ErrorCircle24Filled,
} from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'


const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    gap: '16px',
    padding: '16px',
    overflow: 'auto',
  },
  infoBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 12px',
    backgroundColor: '#e3f2fd',
    borderRadius: '6px',
    fontSize: '12px',
  },
  baseUrl: {
    fontFamily: 'Consolas, Monaco, monospace',
    color: '#1976d2',
    fontWeight: '600',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
  },
  buttonRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '12px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  resultContainer: {
    flex: 1,
    minHeight: '200px',
  },
  resultCard: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  resultPreview: {
    flex: 1,
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: 'Consolas, Monaco, monospace',
    fontSize: '12px',
    padding: '12px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  success: {
    color: '#4caf50',
  },
  error: {
    color: '#f44336',
  },
  info: {
    color: '#2196f3',
  },
  metaInfo: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '8px 12px',
    backgroundColor: '#2d2d2d',
    borderBottom: '1px solid #444',
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  urlText: {
    color: '#9e9e9e',
    fontSize: '11px',
    fontFamily: 'Consolas, Monaco, monospace',
  },
  methodTag: {
    fontSize: '10px',
    padding: '2px 6px',
    borderRadius: '4px',
    fontWeight: '600',
  },
  methodNative: {
    backgroundColor: '#4caf50',
    color: '#fff',
  },
  methodTauri: {
    backgroundColor: '#2196f3',
    color: '#fff',
  },
  methodRust: {
    backgroundColor: '#ff9800',
    color: '#fff',
  },
})

const API_BASE = 'https://sfm.b9349.dpdns.org'

function getHttpCodeColor(code) {
  if (code === 'NETWORK_ERROR') return 'danger'
  if (code >= 200 && code < 300) return 'success'
  if (code >= 400 && code < 500) return 'warning'
  if (code >= 500) return 'danger'
  return 'informative'
}

export function ApiTestTab() {
  const { t } = useTranslation()
  const styles = useStyles()

  function formatHttpCode(code) {
    if (code === 'NETWORK_ERROR') return t('workshop.loadFailed')
    return code
  }
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(null)

  // 方法1: 原生 fetch
  const callNativeFetch = async (endpointName, path, method = 'GET', body = null) => {
    const key = `${endpointName}-native`
    setLoading(key)
    const startTime = Date.now()
    const url = `${API_BASE}${path}`

    try {
      const res = await window.fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })

      const duration = Date.now() - startTime
      const data = await res.json()

      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: '原生fetch',
        methodClass: styles.methodNative,
        desc: `${method} ${path}`,
        url,
        status: res.ok && data.success !== false ? 'success' : 'error',
        httpCode: res.status,
        duration,
        data,
        error: null,
      }, ...prev].slice(0, 20))
    } catch (error) {
      const duration = Date.now() - startTime
      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: '原生fetch',
        methodClass: styles.methodNative,
        desc: `${method} ${path}`,
        url,
        status: 'error',
        httpCode: 'NETWORK_ERROR',
        duration,
        data: null,
        error: error.message,
      }, ...prev].slice(0, 20))
    } finally {
      setLoading(null)
    }
  }

  // 方法2: Tauri HTTP 插件 fetch
  const callTauriFetch = async (endpointName, path, method = 'GET', body = null) => {
    const key = `${endpointName}-tauri`
    setLoading(key)
    const startTime = Date.now()
    const url = `${API_BASE}${path}`

    try {
      const res = await tauriFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })

      const duration = Date.now() - startTime
      const data = await res.json()

      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: 'Tauri插件',
        methodClass: styles.methodTauri,
        desc: `${method} ${path}`,
        url,
        status: res.ok && data.success !== false ? 'success' : 'error',
        httpCode: res.status,
        duration,
        data,
        error: null,
      }, ...prev].slice(0, 20))
    } catch (error) {
      const duration = Date.now() - startTime
      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: 'Tauri插件',
        methodClass: styles.methodTauri,
        desc: `${method} ${path}`,
        url,
        status: 'error',
        httpCode: 'NETWORK_ERROR',
        duration,
        data: null,
        error: error.message,
      }, ...prev].slice(0, 20))
    } finally {
      setLoading(null)
    }
  }

  // 方法3: Rust invoke
  const callRustInvoke = async (endpointName, path, method = 'GET', body = null) => {
    const key = `${endpointName}-rust`
    setLoading(key)
    const startTime = Date.now()
    const url = `${API_BASE}${path}`

    try {
      console.log('[Invoke] Calling http_request:', { url, method, body })
      const resultStr = await invoke('http_request', { url, method, body: body ? JSON.stringify(body) : null })
      console.log('[Invoke] Result:', resultStr)

      const duration = Date.now() - startTime
      const result = JSON.parse(resultStr)
      const data = JSON.parse(result.body)

      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: 'Rust后端',
        methodClass: styles.methodRust,
        desc: `${method} ${path}`,
        url,
        status: result.status >= 200 && result.status < 300 && data.success !== false ? 'success' : 'error',
        httpCode: result.status,
        duration,
        data,
        error: null,
      }, ...prev].slice(0, 20))
    } catch (error) {
      const duration = Date.now() - startTime
      console.error('[Invoke] Error:', error)
      setResults(prev => [{
        id: Date.now(),
        name: endpointName,
        method: 'Rust后端',
        methodClass: styles.methodRust,
        desc: `${method} ${path}`,
        url,
        status: 'error',
        httpCode: 'INVOKE_ERROR',
        duration,
        data: null,
        error: error.message || String(error),
      }, ...prev].slice(0, 20))
    } finally {
      setLoading(null)
    }
  }

  const clearResults = () => setResults([])

  const makeButton = (label, onClick, loadingKey, colorClass) => (
    <Button
      key={loadingKey}
      onClick={onClick}
      disabled={loading !== null}
      appearance="secondary"
      size="small"
      style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
    >
      <span style={{ fontSize: '10px', padding: '2px 4px', borderRadius: '3px', ...colorClass }}>
        {label.split(' ')[0]}
      </span>
      {loading === loadingKey ? '...' : label.split(' ')[1]}
    </Button>
  )

  return (
    <div className={styles.root}>
      <div className={styles.infoBar}>
        <Text size={200}>Base URL:</Text>
        <span className={styles.baseUrl}>{API_BASE}</span>
      </div>

      {/* 登录接口测试 */}
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>登录接口 (POST /api/auth/login)</Text>
        <div className={styles.buttonRow}>
          {makeButton('原生 登录', () => callNativeFetch('登录', '/api/auth/login', 'POST', { username: 'qweqwe', password: 'qweqwe' }), '登录-native', { backgroundColor: '#4caf50', color: '#fff' })}
          {makeButton('Tauri 登录', () => callTauriFetch('登录', '/api/auth/login', 'POST', { username: 'qweqwe', password: 'qweqwe' }), '登录-tauri', { backgroundColor: '#2196f3', color: '#fff' })}
          {makeButton('Rust 登录', () => callRustInvoke('登录', '/api/auth/login', 'POST', { username: 'qweqwe', password: 'qweqwe' }), '登录-rust', { backgroundColor: '#ff9800', color: '#fff' })}
        </div>
      </div>

      {/* 获取模组列表 */}
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>获取模组列表 (GET /api/mods/list)</Text>
        <div className={styles.buttonRow}>
          {makeButton('原生 列表', () => callNativeFetch('列表', '/api/mods/list?page=1&limit=5&lang=zh', 'GET'), '列表-native', { backgroundColor: '#4caf50', color: '#fff' })}
          {makeButton('Tauri 列表', () => callTauriFetch('列表', '/api/mods/list?page=1&limit=5&lang=zh', 'GET'), '列表-tauri', { backgroundColor: '#2196f3', color: '#fff' })}
          {makeButton('Rust 列表', () => callRustInvoke('列表', '/api/mods/list?page=1&limit=5&lang=zh', 'GET'), '列表-rust', { backgroundColor: '#ff9800', color: '#fff' })}
        </div>
      </div>

      {/* 获取用户信息 */}
      <div className={styles.section}>
        <Text className={styles.sectionTitle}>获取用户信息 (GET /api/user/profile)</Text>
        <div className={styles.buttonRow}>
          {makeButton('原生 用户信息', () => callNativeFetch('用户信息', '/api/user/profile', 'GET'), '用户信息-native', { backgroundColor: '#4caf50', color: '#fff' })}
          {makeButton('Tauri 用户信息', () => callTauriFetch('用户信息', '/api/user/profile', 'GET'), '用户信息-tauri', { backgroundColor: '#2196f3', color: '#fff' })}
          {makeButton('Rust 用户信息', () => callRustInvoke('用户信息', '/api/user/profile', 'GET'), '用户信息-rust', { backgroundColor: '#ff9800', color: '#fff' })}
        </div>
      </div>

      <div className={styles.buttonRow}>
        <Button 
          onClick={async () => {
            setLoading('network-test')
            const startTime = Date.now()
            try {
              const result = await invoke('test_network')
              const duration = Date.now() - startTime
              setResults(prev => [{
                id: Date.now(),
                name: '网络诊断',
                method: 'Rust后端',
                methodClass: styles.methodRust,
                desc: 'DNS + HTTP 测试',
                url: 'sfm.b9349.dpdns.org',
                status: 'success',
                httpCode: 200,
                duration,
                data: result,
                error: null,
              }, ...prev].slice(0, 20))
            } catch (error) {
              const duration = Date.now() - startTime
              setResults(prev => [{
                id: Date.now(),
                name: '网络诊断',
                method: 'Rust后端',
                methodClass: styles.methodRust,
                desc: 'DNS + HTTP 测试',
                url: 'sfm.b9349.dpdns.org',
                status: 'error',
                httpCode: 'TEST_ERROR',
                duration,
                data: null,
                error: error.message || String(error),
              }, ...prev].slice(0, 20))
            } finally {
              setLoading(null)
            }
          }} 
          disabled={loading !== null}
          appearance="primary" 
          size="small"
        >
          {loading === 'network-test' ? '测试中...' : '网络诊断'}
        </Button>
        <Button onClick={clearResults} appearance="subtle" size="small">
          清空结果
        </Button>
      </div>

      <div className={styles.resultContainer}>
        {results.length === 0 ? (
          <Card>
            <CardHeader
              header={<Text weight="semibold">API 测试结果</Text>}
              description={<Text>点击上方按钮测试不同方式的请求</Text>}
            />
          </Card>
        ) : (
          results.map((result) => (
            <Card key={result.id} className={styles.resultCard} style={{ marginBottom: '12px' }}>
              <CardHeader
                header={
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {result.status === 'success' ? (
                      <CheckmarkCircle24Filled className={styles.success} />
                    ) : (
                      <ErrorCircle24Filled className={styles.error} />
                    )}
                    <Text weight="semibold">{result.name}</Text>
                    <span style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontWeight: '600',
                      backgroundColor: result.method === '原生fetch' ? '#4caf50' : result.method === 'Tauri插件' ? '#2196f3' : '#ff9800',
                      color: '#fff',
                    }}>
                      {result.method}
                    </span>
                    <Text size={200} style={{ color: '#666' }}>{result.desc}</Text>
                    <Badge appearance="filled" color={getHttpCodeColor(result.httpCode)}>
                      {formatHttpCode(result.httpCode)}
                    </Badge>
                  </div>
                }
                description={
                  <div>
                    <div className={styles.urlText}>{result.url}</div>
                    <div className={styles.metaInfo}>
                      <div className={styles.metaItem}>
                        <Text size={200} className={styles.info}>HTTP:</Text>
                        <Text size={200} className={result.status === 'success' ? styles.success : styles.error}>
                          {result.httpCode}
                        </Text>
                      </div>
                      <div className={styles.metaItem}>
                        <Text size={200} className={styles.info}>耗时:</Text>
                        <Text size={200}>{result.duration}ms</Text>
                      </div>
                      <div className={styles.metaItem}>
                        <Text size={200} className={styles.info}>时间:</Text>
                        <Text size={200}>{new Date(result.id).toLocaleTimeString()}</Text>
                      </div>
                    </div>
                  </div>
                }
              />
              <CardPreview>
                <div className={styles.resultPreview}>
                  {result.error ? (
                    <span className={styles.error}>{result.error}</span>
                  ) : (
                    JSON.stringify(result.data, null, 2)
                  )}
                </div>
              </CardPreview>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
