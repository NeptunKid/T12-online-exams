function normalizeFillRule(expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const blanks = Array.isArray(expected.blanks) ? expected.blanks : [];
    return {
      ordered: expected.ordered !== false,
      blanks: blanks.map((blank) => [...new Set((Array.isArray(blank) ? blank : [blank])
        .map((item) => String(item ?? "").trim().toLocaleLowerCase()).filter(Boolean))])
    };
  }
  const aliases = Array.isArray(expected) ? expected : [expected];
  return {
    ordered: true,
    blanks: [[...new Set(aliases.map((item) => String(item ?? "").trim().toLocaleLowerCase()).filter(Boolean))]]
  };
}

function fillAnswerMatches(actual, expected) {
  const rule = normalizeFillRule(expected);
  const answers = Array.isArray(actual) ? actual : [actual];
  const values = answers.map((item) => String(item ?? "").trim().toLocaleLowerCase());
  if (!values.length || values.some((value) => !value) || values.length !== rule.blanks.length) return false;
  if (rule.ordered) return values.every((value, index) => rule.blanks[index].includes(value));

  const used = new Set();
  function match(index) {
    if (index === values.length) return true;
    for (let slot = 0; slot < rule.blanks.length; slot += 1) {
      if (used.has(slot) || !rule.blanks[slot].includes(values[index])) continue;
      used.add(slot);
      if (match(index + 1)) return true;
      used.delete(slot);
    }
    return false;
  }
  return match(0);
}

module.exports = { fillAnswerMatches, normalizeFillRule };
