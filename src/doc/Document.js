import { addComment } from '../addComment'
import { Char, Type } from '../constants'
import {
  YAMLError,
  YAMLReferenceError,
  YAMLSemanticError,
  YAMLSyntaxError
} from '../errors'
import { documentOptions } from '../options'
import { Schema } from '../schema'
import { Alias } from '../schema/Alias'
import { Collection, isEmptyPath } from '../schema/Collection'
import { Node } from '../schema/Node'
import { Scalar } from '../schema/Scalar'
import { toJSON } from '../toJSON'

import { Anchors } from './Anchors'
import { listTagNames } from './listTagNames'
import { parseContents } from './parseContents'
import { parseDirectives } from './parseDirectives'

const isCollectionItem = node =>
  node && [Type.MAP_KEY, Type.MAP_VALUE, Type.SEQ_ITEM].includes(node.type)

export class Document {
  static defaults = documentOptions

  constructor(options) {
    this.anchors = new Anchors(options.anchorPrefix)
    this.commentBefore = null
    this.comment = null
    this.contents = null
    this.directivesEndMarker = null
    this.errors = []
    this.options = options
    this.schema = null
    this.tagPrefixes = []
    this.version = null
    this.warnings = []
  }

  assertCollectionContents() {
    if (this.contents instanceof Collection) return true
    throw new Error('Expected a YAML collection as document contents')
  }

  add(value) {
    this.assertCollectionContents()
    return this.contents.add(value)
  }

  addIn(path, value) {
    this.assertCollectionContents()
    this.contents.addIn(path, value)
  }

  delete(key) {
    this.assertCollectionContents()
    return this.contents.delete(key)
  }

  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null) return false
      this.contents = null
      return true
    }
    this.assertCollectionContents()
    return this.contents.deleteIn(path)
  }

  getDefaults() {
    return (
      Document.defaults[this.version] ||
      Document.defaults[this.options.version] ||
      {}
    )
  }

  get(key, keepScalar) {
    return this.contents instanceof Collection
      ? this.contents.get(key, keepScalar)
      : undefined
  }

  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && this.contents instanceof Scalar
        ? this.contents.value
        : this.contents
    return this.contents instanceof Collection
      ? this.contents.getIn(path, keepScalar)
      : undefined
  }

  has(key) {
    return this.contents instanceof Collection ? this.contents.has(key) : false
  }

  hasIn(path) {
    if (isEmptyPath(path)) return this.contents !== undefined
    return this.contents instanceof Collection
      ? this.contents.hasIn(path)
      : false
  }

  set(key, value) {
    this.assertCollectionContents()
    this.contents.set(key, value)
  }

  setIn(path, value) {
    if (isEmptyPath(path)) this.contents = value
    else {
      this.assertCollectionContents()
      this.contents.setIn(path, value)
    }
  }

  setSchema(id, customTags) {
    if (!id && !customTags && this.schema) return
    if (typeof id === 'number') id = id.toFixed(1)
    if (id === '1.0' || id === '1.1' || id === '1.2') {
      if (this.version) this.version = id
      else this.options.version = id
      delete this.options.schema
    } else if (id && typeof id === 'string') {
      this.options.schema = id
    }
    if (Array.isArray(customTags)) this.options.customTags = customTags
    const opt = Object.assign({}, this.getDefaults(), this.options)
    this.schema = new Schema(opt)
  }

  parse(node, prevDoc) {
    if (this.options.keepCstNodes) this.cstNode = node
    if (this.options.keepNodeTypes) this.type = 'DOCUMENT'
    const {
      directives = [],
      contents = [],
      directivesEndMarker,
      error,
      valueRange
    } = node
    if (error) {
      if (!error.source) error.source = this
      this.errors.push(error)
    }
    parseDirectives(this, directives, prevDoc)
    if (directivesEndMarker) this.directivesEndMarker = true
    this.range = valueRange ? [valueRange.start, valueRange.end] : null
    this.setSchema()
    this.anchors._cstAliases = []
    parseContents(this, contents)
    this.anchors.resolveNodes()
    if (this.options.prettyErrors) {
      for (const error of this.errors)
        if (error instanceof YAMLError) error.makePretty()
      for (const warn of this.warnings)
        if (warn instanceof YAMLError) warn.makePretty()
    }
    return this
  }

  resolveTagName(node) {
    const { tag, type } = node
    let nonSpecific = false
    if (tag) {
      const { handle, suffix, verbatim } = tag
      if (verbatim) {
        if (verbatim !== '!' && verbatim !== '!!') return verbatim
        const msg = `Verbatim tags aren't resolved, so ${verbatim} is invalid.`
        this.errors.push(new YAMLSemanticError(node, msg))
      } else if (handle === '!' && !suffix) {
        nonSpecific = true
      } else {
        let prefix = this.tagPrefixes.find(p => p.handle === handle)
        if (!prefix) {
          const dtp = this.getDefaults().tagPrefixes
          if (dtp) prefix = dtp.find(p => p.handle === handle)
        }
        if (prefix) {
          if (suffix) {
            if (
              handle === '!' &&
              (this.version || this.options.version) === '1.0'
            ) {
              if (suffix[0] === '^') return suffix
              if (/[:/]/.test(suffix)) {
                // word/foo -> tag:word.yaml.org,2002:foo
                const vocab = suffix.match(/^([a-z0-9-]+)\/(.*)/i)
                return vocab
                  ? `tag:${vocab[1]}.yaml.org,2002:${vocab[2]}`
                  : `tag:${suffix}`
              }
            }
            return prefix.prefix + decodeURIComponent(suffix)
          }
          this.errors.push(
            new YAMLSemanticError(node, `The ${handle} tag has no suffix.`)
          )
        } else {
          const msg = `The ${handle} tag handle is non-default and was not declared.`
          this.errors.push(new YAMLSemanticError(node, msg))
        }
      }
    }
    switch (type) {
      case Type.BLOCK_FOLDED:
      case Type.BLOCK_LITERAL:
      case Type.QUOTE_DOUBLE:
      case Type.QUOTE_SINGLE:
        return Schema.defaultTags.STR
      case Type.FLOW_MAP:
      case Type.MAP:
        return Schema.defaultTags.MAP
      case Type.FLOW_SEQ:
      case Type.SEQ:
        return Schema.defaultTags.SEQ
      case Type.PLAIN:
        return nonSpecific ? Schema.defaultTags.STR : null
      default:
        return null
    }
  }

  resolveNode(node) {
    if (!node) return null
    const { anchors, errors, schema } = this
    let hasAnchor = false
    let hasTag = false
    const comments = { before: [], after: [] }
    const props = isCollectionItem(node.context.parent)
      ? node.context.parent.props.concat(node.props)
      : node.props
    for (const { start, end } of props) {
      switch (node.context.src[start]) {
        case Char.COMMENT:
          {
            if (!node.commentHasRequiredWhitespace(start)) {
              const msg =
                'Comments must be separated from other tokens by white space characters'
              errors.push(new YAMLSemanticError(node, msg))
            }
            const c = node.context.src.slice(start + 1, end)
            const { header, valueRange } = node
            if (
              valueRange &&
              (start > valueRange.start || (header && start > header.start))
            ) {
              comments.after.push(c)
            } else {
              comments.before.push(c)
            }
          }
          break
        case Char.ANCHOR:
          if (hasAnchor) {
            const msg = 'A node can have at most one anchor'
            errors.push(new YAMLSemanticError(node, msg))
          }
          hasAnchor = true
          break
        case Char.TAG:
          if (hasTag) {
            const msg = 'A node can have at most one tag'
            errors.push(new YAMLSemanticError(node, msg))
          }
          hasTag = true
          break
      }
    }
    if (hasAnchor) {
      const name = node.anchor
      const prev = anchors.getNode(name)
      // At this point, aliases for any preceding node with the same anchor
      // name have already been resolved, so it may safely be renamed.
      if (prev) anchors.map[anchors.newName(name)] = prev
      // During parsing, we need to store the CST node in anchors.map as
      // anchors need to be available during resolution to allow for
      // circular references.
      anchors.map[name] = node
    }
    let res
    if (node.type === Type.ALIAS) {
      if (hasAnchor || hasTag) {
        const msg = 'An alias node must not specify any properties'
        errors.push(new YAMLSemanticError(node, msg))
      }
      const name = node.rawValue
      const src = anchors.getNode(name)
      if (!src) {
        const msg = `Aliased anchor not found: ${name}`
        errors.push(new YAMLReferenceError(node, msg))
        return null
      }
      // Lazy resolution for circular references
      res = new Alias(src)
      anchors._cstAliases.push(res)
    } else {
      const tagName = this.resolveTagName(node)
      if (tagName) {
        res = schema.resolveNodeWithFallback(this, node, tagName)
      } else {
        if (node.type !== Type.PLAIN) {
          const msg = `Failed to resolve ${node.type} node here`
          errors.push(new YAMLSyntaxError(node, msg))
          return null
        }
        try {
          res = schema.resolveScalar(node.strValue || '')
        } catch (error) {
          if (!error.source) error.source = node
          errors.push(error)
          return null
        }
      }
    }
    if (res) {
      res.range = [node.range.start, node.range.end]
      if (this.options.keepCstNodes) res.cstNode = node
      if (this.options.keepNodeTypes) res.type = node.type
      const cb = comments.before.join('\n')
      if (cb) {
        res.commentBefore = res.commentBefore
          ? `${res.commentBefore}\n${cb}`
          : cb
      }
      const ca = comments.after.join('\n')
      if (ca) res.comment = res.comment ? `${res.comment}\n${ca}` : ca
    }
    return (node.resolved = res)
  }

  listNonDefaultTags() {
    return listTagNames(this.contents).filter(
      t => t.indexOf(Schema.defaultPrefix) !== 0
    )
  }

  setTagPrefix(handle, prefix) {
    if (handle[0] !== '!' || handle[handle.length - 1] !== '!')
      throw new Error('Handle must start and end with !')
    if (prefix) {
      const prev = this.tagPrefixes.find(p => p.handle === handle)
      if (prev) prev.prefix = prefix
      else this.tagPrefixes.push({ handle, prefix })
    } else {
      this.tagPrefixes = this.tagPrefixes.filter(p => p.handle !== handle)
    }
  }

  stringifyTag(tag) {
    if ((this.version || this.options.version) === '1.0') {
      const priv = tag.match(/^tag:private\.yaml\.org,2002:([^:/]+)$/)
      if (priv) return '!' + priv[1]
      const vocab = tag.match(/^tag:([a-zA-Z0-9-]+)\.yaml\.org,2002:(.*)/)
      return vocab ? `!${vocab[1]}/${vocab[2]}` : `!${tag.replace(/^tag:/, '')}`
    } else {
      let p = this.tagPrefixes.find(p => tag.indexOf(p.prefix) === 0)
      if (!p) {
        const dtp = this.getDefaults().tagPrefixes
        p = dtp && dtp.find(p => tag.indexOf(p.prefix) === 0)
      }
      if (!p) return tag[0] === '!' ? tag : `!<${tag}>`
      const suffix = tag.substr(p.prefix.length).replace(
        /[!,[\]{}]/g,
        ch =>
          ({
            '!': '%21',
            ',': '%2C',
            '[': '%5B',
            ']': '%5D',
            '{': '%7B',
            '}': '%7D'
          }[ch])
      )
      return p.handle + suffix
    }
  }

  toJSON(arg, onAnchor) {
    const { keepBlobsInJSON, mapAsMap, maxAliasCount } = this.options
    const keep =
      keepBlobsInJSON &&
      (typeof arg !== 'string' || !(this.contents instanceof Scalar))
    const ctx = {
      doc: this,
      indentStep: '  ',
      keep,
      mapAsMap: keep && !!mapAsMap,
      maxAliasCount
    }
    const anchorNames = Object.keys(this.anchors.map)
    if (anchorNames.length > 0)
      ctx.anchors = new Map(
        anchorNames.map(name => [
          this.anchors.map[name],
          { alias: [], aliasCount: 0, count: 1 }
        ])
      )
    const res = toJSON(this.contents, arg, ctx)
    if (typeof onAnchor === 'function' && ctx.anchors)
      for (const { count, res } of ctx.anchors.values()) onAnchor(res, count)
    return res
  }

  toString() {
    if (this.errors.length > 0)
      throw new Error('Document with errors cannot be stringified')
    const indentSize = this.options.indent
    if (!Number.isInteger(indentSize) || indentSize <= 0) {
      const s = JSON.stringify(indentSize)
      throw new Error(`"indent" option must be a positive integer, not ${s}`)
    }
    this.setSchema()
    const lines = []
    let hasDirectives = false
    if (this.version) {
      let vd = '%YAML 1.2'
      if (this.schema.name === 'yaml-1.1') {
        if (this.version === '1.0') vd = '%YAML:1.0'
        else if (this.version === '1.1') vd = '%YAML 1.1'
      }
      lines.push(vd)
      hasDirectives = true
    }
    const tagNames = this.listNonDefaultTags()
    this.tagPrefixes.forEach(({ handle, prefix }) => {
      if (tagNames.some(t => t.indexOf(prefix) === 0)) {
        lines.push(`%TAG ${handle} ${prefix}`)
        hasDirectives = true
      }
    })
    if (hasDirectives || this.directivesEndMarker) lines.push('---')
    if (this.commentBefore) {
      if (hasDirectives || !this.directivesEndMarker) lines.unshift('')
      lines.unshift(this.commentBefore.replace(/^/gm, '#'))
    }
    const ctx = {
      anchors: {},
      doc: this,
      indent: '',
      indentStep: ' '.repeat(indentSize)
    }
    let chompKeep = false
    let contentComment = null
    if (this.contents) {
      if (this.contents instanceof Node) {
        if (
          this.contents.spaceBefore &&
          (hasDirectives || this.directivesEndMarker)
        )
          lines.push('')
        if (this.contents.commentBefore)
          lines.push(this.contents.commentBefore.replace(/^/gm, '#'))
        // top-level block scalars need to be indented if followed by a comment
        ctx.forceBlockIndent = !!this.comment
        contentComment = this.contents.comment
      }
      const onChompKeep = contentComment ? null : () => (chompKeep = true)
      const body = this.schema.stringify(
        this.contents,
        ctx,
        () => (contentComment = null),
        onChompKeep
      )
      lines.push(addComment(body, '', contentComment))
    } else if (this.contents !== undefined) {
      lines.push(this.schema.stringify(this.contents, ctx))
    }
    if (this.comment) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== '')
        lines.push('')
      lines.push(this.comment.replace(/^/gm, '#'))
    }
    return lines.join('\n') + '\n'
  }
}