/**
 * Bounded character buffer for terminal scrollback. Appends are O(1) until the
 * cap is reached, after which the oldest characters are dropped to keep the
 * buffer at or below `maxBytes`. Truncation aligns to the next newline when
 * possible so the visible top is a clean line break.
 */
export class CharRingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly maxBytes: number) {
    if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  }

  append(s: string): void {
    if (!s) return;
    this.chunks.push(s);
    this.size += s.length;
    if (this.size <= this.maxBytes) return;
    this.compact();
  }

  toString(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    const joined = this.chunks.join('');
    this.chunks = [joined];
    return joined;
  }

  get length(): number {
    return this.size;
  }

  private compact(): void {
    let joined = this.chunks.join('');
    if (joined.length <= this.maxBytes) {
      this.chunks = [joined];
      this.size = joined.length;
      return;
    }
    const overflow = joined.length - this.maxBytes;
    let cut = overflow;
    // Snap to next newline so a partial line isn't shown at the top.
    const nextNl = joined.indexOf('\n', cut);
    if (nextNl !== -1 && nextNl - cut < 1024) cut = nextNl + 1;
    joined = joined.slice(cut);
    this.chunks = [joined];
    this.size = joined.length;
  }
}
