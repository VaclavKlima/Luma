import { useEffect, useId, useRef } from 'react'
import styles from './AdjustmentInput.module.css'

interface Props {
  label: string
  value: number
  min: number
  max: number
  step: number
  precision: number
  unit?: string
  disabled?: boolean
  /** Change when confirmed state replaces a local gesture, including external updates. */
  resetKey?: string | number
  onChange: (value: number) => void
  onCommit: () => void
  onCancel: () => void
}

/** A presentation control; the owner manages drafts, persistence, and history. */
export function AdjustmentInput({
  label,
  value,
  min,
  max,
  step,
  precision,
  unit,
  disabled,
  resetKey,
  onChange,
  onCommit,
  onCancel,
}: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  const previousReset = useRef(resetKey)
  useEffect(() => {
    const replaced = previousReset.current !== resetKey
    previousReset.current = resetKey
    if (!input.current || (editing.current && !replaced)) return
    input.current.value = value.toFixed(precision)
    input.current.removeAttribute('aria-invalid')
    editing.current = false
  }, [value, precision, resetKey])

  function cancel() {
    editing.current = false
    if (input.current) {
      input.current.value = value.toFixed(precision)
      input.current.removeAttribute('aria-invalid')
    }
    onCancel()
  }
  function commitNumber() {
    if (!input.current) return
    if (!input.current.validity.valid || input.current.value === '') {
      cancel()
      return
    }
    editing.current = false
    input.current.value = input.current.valueAsNumber.toFixed(precision)
    onCommit()
  }
  return (
    <div className={styles.control}>
      <div className={styles.heading}>
        <label htmlFor={id}>{label}</label>
        <div className={styles.value}>
          <input
            ref={input}
            className={styles.number}
            type="number"
            inputMode="decimal"
            aria-label={`${label} value`}
            aria-describedby={unit ? `${id}-unit` : undefined}
            min={min}
            max={max}
            step={step}
            defaultValue={value.toFixed(precision)}
            disabled={disabled}
            onFocus={() => {
              editing.current = true
            }}
            onChange={(event) => {
              const element = event.currentTarget
              const valid = element.validity.valid && element.value !== ''
              element.setAttribute('aria-invalid', String(!valid))
              editing.current = true
              if (valid) {
                onChange(element.valueAsNumber)
              } else {
                // Discard any earlier valid draft so invalid text cannot save on shutdown.
                onCancel()
              }
            }}
            onBlur={commitNumber}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                if (event.key === 'Escape') cancel()
                else commitNumber()
              }
            }}
          />
          {unit && (
            <span id={`${id}-unit`} className={styles.unit}>
              {unit}
            </span>
          )}
        </div>
      </div>
      <input
        id={id}
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={`${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerUp={onCommit}
        onPointerCancel={onCancel}
        onLostPointerCapture={onCommit}
        onBlur={onCommit}
        onKeyUp={(event) => {
          if (
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'PageUp',
              'PageDown',
              'Home',
              'End',
            ].includes(event.key)
          )
            onCommit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
    </div>
  )
}
