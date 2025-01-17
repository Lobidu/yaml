import { isCollection, isNode, isScalar, isSeq } from '../nodes/Node.js'
import type { Pair } from '../nodes/Pair.js'
import { Scalar } from '../nodes/Scalar.js'
import { stringify, StringifyContext } from './stringify.js'
import { indentComment, lineComment } from './stringifyComment.js'

export function stringifyPair(
  { key, value }: Readonly<Pair>,
  ctx: StringifyContext,
  onComment?: () => void,
  onChompKeep?: () => void
) {
  const {
    allNullValues,
    doc,
    indent,
    indentStep,
    options: { commentString, indentSeq, simpleKeys }
  } = ctx
  let keyComment = (isNode(key) && key.comment) || null
  if (simpleKeys) {
    if (keyComment) {
      throw new Error('With simple keys, key nodes cannot have comments')
    }
    if (isCollection(key)) {
      const msg = 'With simple keys, collection cannot be used as a key value'
      throw new Error(msg)
    }
  }
  let explicitKey =
    !simpleKeys &&
    (!key ||
      (keyComment && value == null && !ctx.inFlow) ||
      isCollection(key) ||
      (isScalar(key)
        ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL
        : typeof key === 'object'))

  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  })
  let keyCommentDone = false
  let chompKeep = false
  let str = stringify(
    key,
    ctx,
    () => (keyCommentDone = true),
    () => (chompKeep = true)
  )

  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error(
        'With simple keys, single line scalar must not span more than 1024 characters'
      )
    explicitKey = true
  }

  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment) onComment()
      return explicitKey ? `? ${str}` : str
    }
  } else if ((allNullValues && !simpleKeys) || (value == null && explicitKey)) {
    str = `? ${str}`
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment))
    } else if (chompKeep && onChompKeep) onChompKeep()
    return str
  }

  if (keyCommentDone) keyComment = null
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment))
    str = `? ${str}\n${indent}:`
  } else {
    str = `${str}:`
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment))
  }

  let vcb = ''
  let valueComment = null
  if (isNode(value)) {
    if (value.spaceBefore) vcb = '\n'
    if (value.commentBefore) {
      const cs = commentString(value.commentBefore)
      vcb += `\n${indentComment(cs, ctx.indent)}`
    }
    valueComment = value.comment
  } else if (value && typeof value === 'object') {
    value = doc.createNode(value)
  }
  ctx.implicitKey = false
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1
  chompKeep = false
  if (
    !indentSeq &&
    indentStep.length >= 2 &&
    !ctx.inFlow &&
    !explicitKey &&
    isSeq(value) &&
    !value.flow &&
    !value.tag &&
    !value.anchor
  ) {
    // If indentSeq === false, consider '- ' as part of indentation where possible
    ctx.indent = ctx.indent.substr(2)
  }

  let valueCommentDone = false
  const valueStr = stringify(
    value,
    ctx,
    () => (valueCommentDone = true),
    () => (chompKeep = true)
  )
  let ws = ' '
  if (vcb || keyComment) {
    ws = valueStr === '' && !ctx.inFlow ? vcb : `${vcb}\n${ctx.indent}`
  } else if (!explicitKey && isCollection(value)) {
    const flow = valueStr[0] === '[' || valueStr[0] === '{'
    if (!flow || valueStr.includes('\n')) ws = `\n${ctx.indent}`
  } else if (valueStr === '' || valueStr[0] === '\n') ws = ''
  str += ws + valueStr

  if (ctx.inFlow) {
    if (valueCommentDone && onComment) onComment()
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment))
  } else if (chompKeep && onChompKeep) {
    onChompKeep()
  }

  return str
}
