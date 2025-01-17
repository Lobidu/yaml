import { Document } from '../doc/Document.js'
import { isNode } from '../nodes/Node.js'
import { ToStringOptions } from '../options.js'
import {
  createStringifyContext,
  stringify,
  StringifyContext
} from './stringify.js'
import { indentComment, lineComment } from './stringifyComment.js'

export function stringifyDocument(
  doc: Readonly<Document>,
  options: ToStringOptions
) {
  const lines: string[] = []
  let hasDirectives = options.directives === true
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc)
    if (dir) {
      lines.push(dir)
      hasDirectives = true
    } else if (doc.directives.marker) hasDirectives = true
  }
  if (hasDirectives) lines.push('---')

  const ctx: StringifyContext = createStringifyContext(doc, options)
  const { commentString } = ctx.options

  if (doc.commentBefore) {
    if (lines.length !== 1) lines.unshift('')
    const cs = commentString(doc.commentBefore)
    lines.unshift(indentComment(cs, ''))
  }

  let chompKeep = false
  let contentComment = null
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives) lines.push('')
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore)
        lines.push(indentComment(cs, ''))
      }
      // top-level block scalars need to be indented if followed by a comment
      ctx.forceBlockIndent = !!doc.comment
      contentComment = doc.contents.comment
    }
    const onChompKeep = contentComment ? undefined : () => (chompKeep = true)
    let body = stringify(
      doc.contents,
      ctx,
      () => (contentComment = null),
      onChompKeep
    )
    if (contentComment)
      body += lineComment(body, '', commentString(contentComment))
    if (
      (body[0] === '|' || body[0] === '>') &&
      lines[lines.length - 1] === '---'
    ) {
      // Top-level block scalars with a preceding doc marker ought to use the
      // same line for their header.
      lines[lines.length - 1] = `--- ${body}`
    } else lines.push(body)
  } else {
    lines.push(stringify(doc.contents, ctx))
  }
  let dc = doc.comment
  if (dc && chompKeep) dc = dc.replace(/^\n+/, '')
  if (dc) {
    if ((!chompKeep || contentComment) && lines[lines.length - 1] !== '')
      lines.push('')
    lines.push(indentComment(commentString(dc), ''))
  }
  return lines.join('\n') + '\n'
}
