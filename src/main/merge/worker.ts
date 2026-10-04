import { mergeFailure } from '../../shared/merge'
import { runMerge, pauseMerge, type MergeJob } from './engine'
const send = (message: unknown) => {
  if (process.connected) process.send?.(message)
}
process.on('disconnect', () => process.exit(0))
process.on('message', (message: { type: string; job?: MergeJob }) => {
  if (message.type === 'pause') pauseMerge(true)
  if (message.type === 'resume') pauseMerge(false)
  if (message.type === 'run')
    void runMerge(message.job!).then(
      (result) => send({ result }),
      (error) => {
        const failure = mergeFailure(error)
        if (!failure.filenames.length)
          failure.filenames = message.job!.sources.map((source) => source.photo.filename)
        send({ error: failure })
      },
    )
})
