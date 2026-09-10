# Synthetic native file fixtures

These files contain generated test transactions only. They are not personal
financial records. `expected.json` records byte sizes, SHA-256 and expected totals.

- `synthetic-wechat-large.csv`: UTF-8 BOM and CRLF, 300 transactions, larger than
  a single 64 KiB file read. Repeated text deliberately exercises chunk boundaries.
- `synthetic-alipay-gbk.csv`: GBK Chinese text, two exact decimal transactions.
- `synthetic-wechat-deflated.xlsx`: ordinary DEFLATE ZIP with shared strings,
  a styled numeric Excel date, and a transaction ID with leading zeroes.

Git attributes preserve the CSV bytes without newline or encoding conversion.
Use only a dedicated empty emulator for `tests/native_import_ui_test.py`. It
imports these records, checks duplicates and conflicts, then uses batch undo and
deletes its own remaining manual/screenshot fixtures. It restores screen timeout
even if a check fails; investigate a failed run before starting another.
