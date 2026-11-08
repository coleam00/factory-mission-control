import { expect, test } from 'bun:test';
import { AnswerSplitter } from './manager-stream';

function split(deltas: string[]) {
  const splitter = new AnswerSplitter();
  const shown = deltas.map((d) => splitter.push(d)).join('');
  const { text, block } = splitter.end();
  return { prose: shown + text, block };
}

test('a fence split across deltas never reaches the prose', () => {
  expect(split(['Two failed.\n``', '`mc\n{"runs":[]}', '\n```\n'])).toEqual({
    prose: 'Two failed.\n',
    block: '\n{"runs":[]}\n',
  });
  expect(split(['Hi `', 'mc', ' fence\n```mc\n{}\n```'])).toEqual({
    prose: 'Hi `mc fence\n',
    block: '\n{}\n',
  });
});

test('an answer with no fence passes whole, and text after the closing fence is dropped', () => {
  expect(split(['all ', 'prose ``'])).toEqual({ prose: 'all prose ``', block: null });
  expect(split(['a```mc\n{}\n```\nafter'])).toEqual({ prose: 'a', block: '\n{}\n' });
});
