import { useCallback, useRef, useState } from 'react'
import {
  PAGE_SIZE,
  type LibraryEvent,
  type Photo,
  type PhotoReference,
} from '../../../shared/contracts'

interface LibraryState {
  photos: Photo[]
  total: number
  offset: number
  position: number
  photo: Photo | null
  selected: Map<string, PhotoReference>
  anchor: string | null
  activeId: string | null
}
export interface SelectionModifiers {
  shift?: boolean
  toggle?: boolean
}

export function useLibrary(onError: (error: string) => void) {
  const [state, setState] = useState<LibraryState>({
    photos: [],
    total: 0,
    offset: 0,
    position: 0,
    photo: null,
    selected: new Map(),
    anchor: null,
    activeId: null,
  })
  const current = useRef(state)
  const request = useRef(0)
  const refreshing = useRef(0)
  const navigating = useRef(false)
  const initialized = useRef(false)
  const pendingSelection = useRef(Promise.resolve())
  const selectionError = useRef<unknown>(null)
  const update = useCallback((next: Partial<LibraryState>) => {
    current.current = { ...current.current, ...next }
    setState(current.current)
  }, [])

  const refresh = useCallback(
    async (firstImportedId?: string) => {
      if (navigating.current) return
      const ticket = request.current
      const refreshTicket = ++refreshing.current
      try {
        const previous = current.current
        const id = previous.activeId ?? firstImportedId
        const located = id ? await window.luma.locatePhoto(id) : null
        let pageOffset = previous.offset
        let page = await window.luma.listPhotos(pageOffset)
        if (pageOffset >= page.total && pageOffset > 0) {
          pageOffset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE)
          page = await window.luma.listPhotos(pageOffset)
        }
        if (ticket !== request.current || refreshTicket !== refreshing.current) return
        const photo = located
          ? located.photos[located.index - located.offset]
          : (page.photos[0] ?? null)
        const firstSelection = (!initialized.current || previous.total === 0) && photo !== null
        if (photo) initialized.current = true
        update({
          photos: page.photos,
          total: page.total,
          offset: pageOffset,
          photo,
          activeId: photo?.id ?? null,
          position: located?.index ?? pageOffset,
          ...(firstSelection
            ? { selected: new Map([[photo!.id, photo!]]), anchor: photo!.id }
            : {}),
        })
      } catch (error) {
        if (ticket === request.current) onError(String(error))
      }
    },
    [onError, update],
  )

  const onEvent = useCallback(
    (event: LibraryEvent) => {
      if (!event.libraryChanged) return
      const previous = current.current
      if (event.deletedIds?.length) {
        request.current++
        navigating.current = false
        const removed = new Set(event.deletedIds)
        const selected = new Map([...previous.selected].filter(([id]) => !removed.has(id)))
        const activeRemoved = previous.activeId !== null && removed.has(previous.activeId)
        update({
          selected,
          anchor: previous.anchor && removed.has(previous.anchor) ? null : previous.anchor,
          ...(activeRemoved ? { activeId: event.replacementId ?? null } : {}),
        })
      }
      void refresh(event.firstImportedId)
    },
    [refresh, update],
  )

  const select = useCallback(
    (photo: Photo, modifiers: SelectionModifiers = {}) => {
      selectionError.current = null
      const work = (async () => {
        const ticket = ++request.current
        navigating.current = true
        try {
          const previous = current.current
          let selected: Map<string, PhotoReference>
          let anchor = previous.anchor
          if (modifiers.shift && anchor) {
            const range = await window.luma.getPhotoRange(anchor, photo.id)
            if (ticket !== request.current) return
            selected = new Map(modifiers.toggle ? previous.selected : [])
            for (const item of range) selected.set(item.id, item)
          } else {
            anchor = photo.id
            selected = new Map(modifiers.toggle ? previous.selected : [])
            if (modifiers.toggle && selected.has(photo.id)) selected.delete(photo.id)
            else selected.set(photo.id, { id: photo.id, filename: photo.filename })
          }
          const index = previous.photos.findIndex((item) => item.id === photo.id)
          update({ selected, anchor, photo, activeId: photo.id, position: previous.offset + index })
        } catch (error) {
          if (ticket === request.current) {
            selectionError.current = error
            onError(String(error))
          }
        } finally {
          if (ticket === request.current) {
            navigating.current = false
            void refresh()
          }
        }
      })()
      pendingSelection.current = work
      return work
    },
    [onError, refresh, update],
  )

  const getSelection = useCallback(async () => {
    let pending: Promise<void>
    do {
      pending = pendingSelection.current
      await pending
    } while (pending !== pendingSelection.current)
    if (selectionError.current) throw selectionError.current
    return [...current.current.selected.values()]
  }, [])

  const contextSelect = useCallback(
    (photo: Photo) => {
      request.current++
      navigating.current = false
      selectionError.current = null
      const previous = current.current
      const selected = previous.selected.has(photo.id)
        ? previous.selected
        : new Map([[photo.id, { id: photo.id, filename: photo.filename }]])
      update({
        selected,
        photo,
        activeId: photo.id,
        anchor: selected === previous.selected ? previous.anchor : photo.id,
      })
      void refresh()
      return [...selected.values()]
    },
    [refresh, update],
  )

  const navigate = useCallback(
    async (delta: -1 | 1) => {
      const id = current.current.activeId
      if (!id) return
      const ticket = ++request.current
      navigating.current = true
      try {
        const result = await window.luma.locatePhoto(id, delta)
        if (!result || ticket !== request.current) return
        const photo = result.photos[result.index - result.offset]
        update({
          photos: result.photos,
          total: result.total,
          offset: result.offset,
          position: result.index,
          photo,
          activeId: photo.id,
          anchor: photo.id,
          selected: new Map([[photo.id, photo]]),
        })
      } catch (error) {
        onError(String(error))
      } finally {
        if (ticket === request.current) {
          navigating.current = false
          void refresh()
        }
      }
    },
    [onError, refresh, update],
  )

  const changePage = useCallback(
    async (offset: number) => {
      const ticket = ++request.current
      navigating.current = true
      try {
        const result = await window.luma.listPhotos(offset)
        if (ticket === request.current)
          update({ photos: result.photos, total: result.total, offset })
      } catch (error) {
        onError(String(error))
      } finally {
        if (ticket === request.current) {
          navigating.current = false
          void refresh()
        }
      }
    },
    [onError, refresh, update],
  )

  return { ...state, refresh, onEvent, select, getSelection, contextSelect, navigate, changePage }
}
