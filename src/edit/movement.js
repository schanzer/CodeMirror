import { prepareMeasureCharTop } from "../measurement/position_measurement"
import { bidiLeft, bidiRight, getBidiPartAt, getOrder, lineLeft, lineRight, moveLogically } from "../util/bidi"
import { findFirst, isExtendingChar } from "../util/misc"

export function endOfLine(visually, cm, lineObj, dir) {
  let ch, sticky = "before"
  if (visually) {
    let order = getOrder(lineObj)
    if (order) {
      let i = dir < 0 ? order.length - 1 : 0
      while (order[i].to == order[i].from) i += dir
      let part = order[i]
      // With a wrapped rtl chunk (possibly spanning multiple bidi parts),
      // it could be that the last bidi part is not on the last visual line,
      // since visual lines contain content order-consecutive chunks.
      // Thus, in rtl, we are looking for the first (content-order) character
      // in the rtl chunk that is on the last line (that is, the same line
      // as the last (content-order) character).
      if (dir < 0 && part.level > 0) {
        let getTop = prepareMeasureCharTop(cm, lineObj)
        ch = lineObj.text.length - 1
        let targetTop = getTop(ch)
        ch = findFirst(ch => getTop(ch) == targetTop, part.from, ch)
        if (part.level == 1) sticky = "after"
        else ch = moveLogically(lineObj, ch, 1, true)
        return {ch, sticky}
      }
      ch = (dir < 0 ? bidiRight : bidiLeft)(part)
      return {ch, sticky}
    }
  }
  if (visually) ch = (dir < 0 ? lineRight : lineLeft)(lineObj)
  else ch = dir < 0 ? lineObj.text.length : 0
  return {ch, sticky}
}

export function moveVisually(cm, line, start, dir, byUnit, startSticky) {
  let mv = (ch, dir) => moveLogically(line, ch, dir, byUnit)
  let bidi = getOrder(line)
  if (!bidi) return {ch: mv(start, dir), sticky: dir < 0 ? "after" : "before"}
  if (start >= line.text.length) {
    start = line.text.length
    startSticky = "before"
  } else if (start <= 0) {
    start = 0
    startSticky = "after"
  }
  let partPos = getBidiPartAt(bidi, start, startSticky), part = bidi[partPos]
  if (part.level % 2 == 0 && (dir > 0 ? part.to > start : part.from < start)) {
    // Case 1: We move within an ltr part. Even with wrapped lines,
    // nothing interesting happens.
    return {ch: mv(start, dir), sticky: dir < 0 ? "after" : "before"}
  }

  let getCharTop
  if (cm.options.lineWrapping) {
    let tops = {}
    let measureTop = prepareMeasureCharTop(cm, line)
    getCharTop = ch => tops.hasOwnProperty(ch) ? tops[ch] : tops[ch] = measureTop(ch)
  } else {
    getCharTop = () => 0
  }
  let getCursorTop = (ch, sticky) => getCharTop(sticky == "before" ? mv(ch, -1) : ch)
  let startTop = getCursorTop(start, startSticky)

  let intoRtlLine = (start, sticky, startTop, dir, part) => {
    ch = findFirst(ch => getCursorTop(ch, sticky) == startTop, dir > 0 ? mv(part.to, -1) : mv(part.from, 1), start)
    while (ch != start && isExtendingChar(line.text.charAt(ch))) ch -= dir
    return {ch, sticky}
  }

  if (part.level % 2 == 1) {
    let sticky = dir < 0 ? "before" : "after"

    // Case 2a: We move within an rtl part on the same visual line
    let ch = mv(start, -dir)
    if (ch != null && (dir > 0 ? ch >= part.from : ch <= part.to)) {
      if (getCursorTop(ch, sticky) == startTop) return {ch, sticky}
    }

    // Case 2b: We move within an rtl part but have to leave the current visual line
    // That means we have to find the last char in content order that is on the next
    // visual line
    ch = start
    let chTop

    // We iterate in content order over all the chars that are on the current line
    // until we find the first position that is on the next line
    do {
      ch = mv(ch, dir)
      if (ch == null) break
      if (dir > 0 ? ch > part.to : ch < part.from) { ch = null; break }
    } while ((chTop = getCursorTop(ch, sticky)) == chTop)

    if (ch != null) {
      // Second, find the last position that is on that line
      return intoRtlLine(ch, sticky, chTop, dir, part)
    }
  }

  // Case 3: Could not move within this bidi part in this or the next visual line, so leave
  // the current bidi part

  // Case 3a: Look for other bidi parts on the same visual line
  let lastChar = dir > 0 ? line.text.length : 0
  while (partPos + dir >= 0 && partPos + dir < bidi.length) {
    partPos += dir
    part = bidi[partPos]
    if (part.from == part.to) continue
    let ch = dir > 0 ? part.from : mv(part.to, -1)
    if (dir > 0 ? (ch > lastChar) : (ch < lastChar)) continue
    let moveInStorageOrder = (dir > 0) == (part.level != 1)
    if (moveInStorageOrder) ch = mv(ch, 1)
    let sticky = moveInStorageOrder ? "before" : "after"
    let chTop = getCursorTop(ch, sticky)
    if (chTop == startTop) {
      return part.level == 1 ? intoRtlLine(ch, sticky, startTop, dir, part) : {ch, sticky}
    }
    if ((dir > 0) == (chTop > startTop)) {
      // This is a performance optimization
      // Every character after `ch` (in direction `dir`) is going to be
      // in the same visual line as `ch` or even farther away
      lastChar = ch
    }
  }

  // Case 3b: Look for other bidi parts on the next visual line

  // Step 1: Get the first and the last char on the next visual line
  let curTop, ch = startSticky == "before" ? mv(start, -1) : start
  do {
    ch = mv(ch, dir)
    if (ch == null) return { ch }
    curTop = getCharTop(ch)
  } while (startTop == curTop)
  let lastCh = findFirst(ch => getCharTop(ch) == curTop, dir > 0 ? line.text.length - 1 : 0, ch)
  let visualLineChars = dir > 0 ? [ch, lastCh] : [lastCh, ch]

  let getRes = (ch, moveInStorageOrder) => moveInStorageOrder
    ? {ch: mv(ch, 1), sticky: "before"}
    : {ch, sticky: "after"}

  // Step 2: Get the first bidi part on the visual line in move direction and line.order order
  for (partPos = dir > 0 ? dir : bidi.length + dir; partPos >= 0 && partPos < bidi.length; partPos += dir) {
    let part = bidi[partPos]
    let moveInStorageOrder = (dir > 0) == (part.level != 1)
    let ch = moveInStorageOrder ? visualLineChars[0] : visualLineChars[1]
    if (part.from <= ch && ch < part.to) return getRes(ch, moveInStorageOrder)
    ch = moveInStorageOrder ? part.from : mv(part.to, -1)
    if (visualLineChars[0] <= ch && ch <= visualLineChars[1]) return getRes(ch, moveInStorageOrder)
  }

  // Case 4: Nothing to move
  return {ch: null, sticky: null}
}
