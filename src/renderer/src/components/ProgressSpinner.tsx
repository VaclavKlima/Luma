import { LoaderCircle } from 'lucide-react'
import styles from './TaskProgress.module.css'

export function ProgressSpinner() {
  return <LoaderCircle size={12} className={styles.spinner} aria-hidden="true" />
}
