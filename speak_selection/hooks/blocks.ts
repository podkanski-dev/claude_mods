const BOX = /[─-╿]/

const isTable = (block: string) => block.split('\n').every(line => BOX.test(line))

// Blocks are separated by blank lines, but a drawn table stays whole even
// where it has blank rows, so each table is described in one rewrite.
// Past maxChars the rest is dropped at a block boundary; the first block is
// always kept so one huge table still gets read.
export function splitBlocks(text: string, maxChars = 12000): { blocks: string[]; isTruncated: boolean } {
  const merged: string[] = []
  for (const block of text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)) {
    const last = merged.at(-1)
    if (last !== undefined && isTable(last) && isTable(block)) {
      merged[merged.length - 1] = `${last}\n\n${block}`
    } else {
      merged.push(block)
    }
  }

  const blocks: string[] = []
  let size = 0
  for (const block of merged) {
    size += block.length
    if (blocks.length > 0 && size > maxChars) {
      return { blocks, isTruncated: true }
    }
    blocks.push(block)
  }
  return { blocks, isTruncated: false }
}
