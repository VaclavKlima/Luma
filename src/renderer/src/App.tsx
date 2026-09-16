import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Aperture,
  ArrowDownToLine,
  ArrowUpFromLine,
  Columns2,
  Crop,
  FileImage,
  Redo2,
  SlidersHorizontal,
  TerminalSquare,
  Undo2,
} from 'lucide-react'
import {
  type AppInfo,
  type Photo,
  type PhotoReference,
  type BackgroundTask,
} from '../../shared/contracts'
import { Library } from './components/Library'
import { Inspector } from './components/Inspector'
import { Console } from './components/Console'
import { ImportDialog } from './components/ImportDialog'
import { TaskCenter } from './components/TaskCenter'
import { useLibrary } from './hooks/useLibrary'
import { DeleteDialog } from './components/DeleteDialog'
import { PhotoContextMenu } from './components/PhotoContextMenu'
import { PhotoPreview } from './components/PhotoPreview'
import styles from './App.module.css'

export function App() {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [error, setError] = useState('')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const consoleToggleRef = useRef<HTMLButtonElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const library = useLibrary(setError)
  const {
    photos,
    total,
    offset,
    position,
    photo,
    selected,
    refresh,
    onEvent,
    select,
    navigate,
    changePage,
    getSelection,
  } = library
  const [deleteTargets, setDeleteTargets] = useState<PhotoReference[] | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    targets: PhotoReference[]
  } | null>(null)
  const actionOrigin = useRef<HTMLElement | null>(null)
  const restoreFocus = useCallback(() => {
    const origin = actionOrigin.current
    if (origin?.isConnected) origin.focus()
    else document.querySelector<HTMLElement>('[data-testid="photo-library"]')?.focus()
  }, [])
  const closeContextMenu = useCallback(
    (restore = false) => {
      setContextMenu(null)
      if (restore) restoreFocus()
    },
    [restoreFocus],
  )
  const requestDeletion = useCallback(
    async (requestedTargets?: PhotoReference[]) => {
      try {
        const targets = requestedTargets ?? (await getSelection())
        if (!targets.length) return
        const current = await window.luma.listTasks()
        setTasks(current)
        setContextMenu(null)
        if (current.some((task) => task.status === 'running' || task.status === 'cancelling')) {
          setTasksOpen(true)
          return
        }
        setTasksOpen(false)
        setDeleteTargets(targets)
      } catch (error) {
        setError(String(error))
      }
    },
    [getSelection],
  )
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'Delete' ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector('dialog[open]') ||
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), #agent-console',
        )
      )
        return
      event.preventDefault()
      if (!contextMenu) actionOrigin.current = document.activeElement as HTMLElement | null
      void requestDeletion(contextMenu?.targets)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [selected, requestDeletion, contextMenu])

  function showContextMenu(photo: Photo, element: HTMLElement, x: number, y: number) {
    actionOrigin.current = element
    setTasksOpen(false)
    setContextMenu({ x, y, targets: library.contextSelect(photo) })
  }

  const refreshTasks = useCallback(async () => {
    try {
      const current = await window.luma.listTasks()
      setTasks(current)
      if (!current.length) setTasksOpen(false)
    } catch (error) {
      setError(String(error))
    }
  }, [])
  const dismissTask = useCallback(
    async (id: string) => {
      await window.luma.dismissTask(id)
      await refreshTasks()
    },
    [refreshTasks],
  )

  useEffect(() => {
    void window.luma.getAppInfo().then(setAppInfo, (error) => setError(String(error)))
    // These refreshes update state only after the desktop bridge responds.
    void refresh()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshTasks()
    return window.luma.onLibraryEvent((event) => {
      onEvent(event)
      if (event.tasksChanged) void refreshTasks()
    })
  }, [refresh, refreshTasks, onEvent])

  useEffect(() => {
    const timers = tasks
      .filter((task) => task.status === 'completed' && task.finishedAt !== undefined)
      .map((task) =>
        setTimeout(
          () => {
            void dismissTask(task.id).catch((error) => setError(String(error)))
          },
          Math.max(0, task.finishedAt! + 5000 - Date.now()),
        ),
      )
    return () => timers.forEach(clearTimeout)
  }, [tasks, dismissTask])

  async function openImport() {
    try {
      const current = await window.luma.listTasks()
      setTasks(current)
      if (current.some((task) => task.status === 'running' || task.status === 'cancelling'))
        setTasksOpen(true)
      else {
        setTasksOpen(false)
        setImportOpen(true)
      }
    } catch (error) {
      setError(String(error))
    }
  }

  function closeReview() {
    setImportOpen(false)
    importButtonRef.current?.focus()
  }

  return (
    <div className={styles.app}>
      <header className={styles.appHeader}>
        <div className={styles.brand}>
          <Aperture size={23} strokeWidth={1.35} />
          <span>luma</span>
          <span className={styles.brandDivider} />
          <span className={styles.workspaceName}>My library</span>
        </div>
        <div className={styles.workspaceMode}>
          <SlidersHorizontal size={13} />
          <span>Library</span>
        </div>
        <div className={styles.headerActions}>
          <button
            className={styles.headerButton}
            onClick={() => void openImport()}
            aria-label="Import photos"
            ref={importButtonRef}
          >
            <ArrowDownToLine size={14} /> Import
          </button>
          <button className={styles.exportButton} disabled aria-label="Export photo">
            <ArrowUpFromLine size={14} /> Export
          </button>
        </div>
      </header>

      <div className={styles.editor} data-testid="workspace">
        <Library
          photos={photos}
          total={total}
          offset={offset}
          onPage={(start) => {
            void changePage(start).catch((error) => setError(String(error)))
          }}
          selectedIds={selected}
          activeId={photo?.id ?? null}
          onSelect={(photo, modifiers) => {
            void select(photo, modifiers)
          }}
          onContextMenu={showContextMenu}
          onImport={() => void openImport()}
        />

        <main className={styles.workspace} aria-label="Photo workspace">
          <div className={styles.previewToolbar}>
            <div className={styles.filename}>
              <FileImage size={13} />
              <span data-testid="preview-filename">{photo?.filename ?? 'No photo selected'}</span>
              <span className={styles.sdrBadge}>SDR</span>
            </div>
            <div className={styles.previewActions}>
              <button className={styles.iconButton} disabled aria-label="Undo">
                <Undo2 size={15} />
              </button>
              <button className={styles.iconButton} disabled aria-label="Redo">
                <Redo2 size={15} />
              </button>
              <span className={styles.toolbarDivider} />
              <button className={styles.iconButton} disabled aria-label="Crop photo">
                <Crop size={15} />
              </button>
              <button className={styles.iconButton} disabled aria-label="Compare before and after">
                <Columns2 size={15} />
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className={styles.errorBanner}>
              {error}
            </p>
          )}
          <PhotoPreview
            key={photo?.id ?? 'empty'}
            photo={photo}
            total={total}
            position={position}
            onNavigate={navigate}
            onImport={() => void openImport()}
            onContextMenu={showContextMenu}
          />

          {consoleOpen && (
            <Console
              onClose={() => {
                setConsoleOpen(false)
                consoleToggleRef.current?.focus()
              }}
            />
          )}
        </main>

        <Inspector photo={photo} />
      </div>

      <footer className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={styles.statusDot} />
          <span>Local library</span>
          <span className={styles.statusSeparator}>/</span>
          <span>{total} photographs</span>
        </div>
        <TaskCenter
          tasks={tasks}
          open={tasksOpen}
          onOpenChange={setTasksOpen}
          onCancel={window.luma.cancelTask}
          onDismiss={dismissTask}
          getErrors={window.luma.getTaskErrors}
        />
        <div className={styles.statusRight}>
          <button
            className={`${styles.consoleToggle} ${consoleOpen ? styles.consoleToggleOpen : ''}`}
            data-testid="console-toggle"
            ref={consoleToggleRef}
            aria-expanded={consoleOpen}
            aria-controls="agent-console"
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            <TerminalSquare size={13} /> Console
          </button>
          <span className={styles.version} data-testid="app-version">
            {appInfo ? `v${appInfo.version}` : 'Starting…'}
          </span>
        </div>
      </footer>
      {contextMenu && (
        <PhotoContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          count={contextMenu.targets.length}
          onClose={closeContextMenu}
          onDelete={() => void requestDeletion(contextMenu.targets)}
        />
      )}
      {deleteTargets && (
        <DeleteDialog
          photos={deleteTargets}
          onClose={() => {
            setDeleteTargets(null)
            restoreFocus()
          }}
          onStarted={() => {
            setDeleteTargets(null)
            restoreFocus()
            void refreshTasks()
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={closeReview}
          onStarted={() => {
            closeReview()
            void refreshTasks()
          }}
        />
      )}
    </div>
  )
}
