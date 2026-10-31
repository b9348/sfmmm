import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// 不使用 StrictMode：开发模式下它会双重调用 useEffect/渲染（首次挂载-卸载-再挂载），
// 导致页面查询、事件监听等副作用重复执行两次；本项目以发布版行为为准，直接单次挂载。
createRoot(document.getElementById('root')).render(
  <App />
)