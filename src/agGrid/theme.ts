import { colorSchemeDark, themeQuartz } from "ag-grid-community";

// AG Grid's built-in neutral dark colour scheme (all backgrounds / foregrounds /
// hover / odd-row colours derived by the theme), plus a few brand tweaks.
export const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: "#8AAAA7",
  borderRadius: 2,
  buttonBorderRadius: 2,
  checkboxBorderRadius: 2,
  columnBorder: true,
  fontFamily: {
    googleFont: "Inter",
  },
  fontSize: 14,
  headerFontFamily: {
    googleFont: "Inter",
  },
  headerFontSize: 14,
  headerFontWeight: 500,
  iconButtonBorderRadius: 1,
  iconSize: 12,
  inputBorderRadius: 2,
  spacing: 6,
  wrapperBorderRadius: 2,
  valueChangeValueHighlightBackgroundColor: "#8AAAA766",
});
