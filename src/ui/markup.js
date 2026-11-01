// Identity tag: enables Prettier's embedded HTML formatting without a runtime dependency.
// This formats static templates; callers still escape any dynamic attribute values.
export function html(strings, ...values) {
  return strings.reduce(
    (output, part, index) => output + part + (index < values.length ? values[index] : ""),
    "",
  );
}
