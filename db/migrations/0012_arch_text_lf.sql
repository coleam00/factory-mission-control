-- Architecture text is stored with LF line endings (issue #172). Before this, arch:parse stored
-- each file as it read it, so a version parsed from a CRLF checkout held CRLF text, and the
-- architecture diff, which hashes stored text, showed identical prompts as changed. arch:parse now
-- reads every file with CRLF as LF. Only the whole-file columns below can hold a CR: YAML values
-- and step comments were already parsed to LF.
--
-- A lone CR is file content and stays. Run again, this changes nothing.

UPDATE mc.arch_workflows SET yaml = replace(yaml, E'\r\n', E'\n') WHERE strpos(yaml, E'\r\n') > 0;
UPDATE mc.arch_texts SET text = replace(text, E'\r\n', E'\n') WHERE strpos(text, E'\r\n') > 0;
UPDATE mc.arch_scripts SET text = replace(text, E'\r\n', E'\n') WHERE strpos(text, E'\r\n') > 0;
UPDATE mc.arch_hooks SET text = replace(text, E'\r\n', E'\n') WHERE strpos(text, E'\r\n') > 0;
