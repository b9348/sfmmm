import { useModEditor } from './modEditor/useModEditor'
import { ModEditorView } from './modEditor/ModEditorView'

export function ModEditorPage({ mode, mod, onClose, onCreated, onUpdated, onRefresh }) {
  const editor = useModEditor({ mode, initialMod: mod, onClose, onCreated, onUpdated, onRefresh })
  return <ModEditorView mode={mode} onClose={onClose} editor={editor} />
}

export function CreateModPage({ onClose, onCreated }) {
  return <ModEditorPage mode="create" onClose={onClose} onCreated={onCreated} />
}

export function EditModPage({ mod, onClose, onUpdated, onRefresh }) {
  return <ModEditorPage mode="edit" mod={mod} onClose={onClose} onUpdated={onUpdated} onRefresh={onRefresh} />
}
