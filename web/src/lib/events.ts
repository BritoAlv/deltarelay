export type Listener<T> = (value: T) => void

// A tiny typed channel for cross-feature observations. It deliberately carries
// values with explicit freshness instead of ad hoc DOM CustomEvents.
export class Channel<T> {
  private listeners = new Set<Listener<T>>()

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(value: T): void {
    for (const listener of this.listeners) listener(value)
  }
}
