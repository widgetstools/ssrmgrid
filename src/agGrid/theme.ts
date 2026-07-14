import { themeQuartz } from "ag-grid-community";

export const theme = themeQuartz.withParams({
  accentColor: "#8AAAA7",
  backgroundColor: "#1f2836",
  borderColor: "#2a3543",
  borderRadius: 2,
  browserColorScheme: "dark",
  buttonBorderRadius: 2,
  cellTextColor: "#e6e8ec",
  checkboxBorderRadius: 2,
  chromeBackgroundColor: {
    ref: "foregroundColor",
    mix: 0.07,
    onto: "backgroundColor",
  },
  columnBorder: true,
  fontFamily: {
    googleFont: "Inter",
  },
  fontSize: 14,
  foregroundColor: "#e6e8ec",
  headerBackgroundColor: "#182029",
  headerFontFamily: {
    googleFont: "Inter",
  },
  headerFontSize: 14,
  headerFontWeight: 500,
  headerTextColor: "#e6e8ec",
  iconButtonBorderRadius: 1,
  iconSize: 12,
  inputBorderRadius: 2,
  oddRowBackgroundColor: "#232c38",
  rowHoverColor: "#2a3543",
  spacing: 6,
  wrapperBorderRadius: 2,
  valueChangeValueHighlightBackgroundColor: "#8AAAA766",
});
