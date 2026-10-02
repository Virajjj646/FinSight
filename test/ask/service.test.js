import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/lib/AppError.js';
import { getGenerator } from '../../src/infrastructure/llm/generator.js';
import {
  askQuestion,
  ABSTAIN_MESSAGE,
  ASK_MIN_SCORE,
} from '../../src/modules/ask/ask.service.js';

const silent = { info() {} };

const chunk = (n, score) => ({
  chunkId: `c${n}`,
  documentId: `d${n}`,
  documentTitle: 'acme-supply-agreement.pdf',
  section: '4. Payment Terms',
  pageStart: 1,
  pageEnd: 2,
  content: `content ${n}`,
  score,
});

const retrieveReturning = (chunks) => {
  const fn = async (args) => {
    fn.args = args;
    return chunks;
  };
  return fn;
};

const generateReturning = (text) => {
  const fn = async (input) => {
    fn.calls.push(input);
    return { text, model: 'fake-model', latencyMs: 5 };
  };
  fn.calls = [];
  return fn;
};

const noneInProgress = async () => false;

const ask = (deps, k) =>
  askQuestion(
    { tenantId: 't1', question: 'What is the late fee?', k },
    { log: silent, documentsInProgress: noneInProgress, ...deps },
  );

test('answers with mapped citations and passes tenant, question and k to retrieval', async () => {
  const retrieve = retrieveReturning([chunk(1, 0.8), chunk(2, 0.7)]);
  const generate = generateReturning('The late fee is 1.5% per month [1].');
  const r = await ask({ retrieve, generate }, 3);

  assert.equal(r.abstained, false);
  assert.equal(r.answer, 'The late fee is 1.5% per month [1].');
  assert.deepEqual(r.citations.map((c) => c.chunkId), ['c1']);
  assert.deepEqual(retrieve.args, { tenantId: 't1', question: 'What is the late fee?', k: 3 });
  assert.match(generate.calls[0].prompt, /<source id="2"/);
  assert.match(generate.calls[0].prompt, /Question: What is the late fee\?$/);
  assert.equal(r.trace.model, 'fake-model');
  assert.equal(r.trace.topScore, 0.8);
});

test('no chunks: abstains without calling the model', async () => {
  const generate = generateReturning('unused');
  const r = await ask({ retrieve: retrieveReturning([]), generate });
  assert.deepEqual(
    { abstained: r.abstained, reason: r.reason, answer: r.answer, citations: r.citations },
    { abstained: true, reason: 'no_documents', answer: ABSTAIN_MESSAGE, citations: [] },
  );
  assert.equal(generate.calls.length, 0);
});

const inProgressRecorder = (result) => {
  const fn = async (args) => {
    fn.calls.push(args);
    return result;
  };
  fn.calls = [];
  return fn;
};

test('no chunks with documents pending or processing: abstains with documents_processing', async () => {
  const generate = generateReturning('unused');
  const consumeLlmBudget = budgetRecorder();
  const documentsInProgress = inProgressRecorder(true);
  const r = await ask({ retrieve: retrieveReturning([]), generate, consumeLlmBudget, documentsInProgress });
  assert.deepEqual(
    { abstained: r.abstained, reason: r.reason, answer: r.answer, citations: r.citations },
    { abstained: true, reason: 'documents_processing', answer: ABSTAIN_MESSAGE, citations: [] },
  );
  assert.deepEqual(documentsInProgress.calls, [{ tenantId: 't1' }]);
  assert.equal(generate.calls.length, 0);
  assert.equal(consumeLlmBudget.calls.length, 0);
});

test('no chunks and nothing in progress: abstains with no_documents', async () => {
  const documentsInProgress = inProgressRecorder(false);
  const r = await ask({ retrieve: retrieveReturning([]), documentsInProgress });
  assert.equal(r.reason, 'no_documents');
  assert.equal(documentsInProgress.calls.length, 1);
});

test('document status is only checked when retrieval is empty', async () => {
  const documentsInProgress = inProgressRecorder(true);
  await ask({ retrieve: retrieveReturning([chunk(1, ASK_MIN_SCORE - 0.01)]), documentsInProgress });
  await ask({
    retrieve: retrieveReturning([chunk(1, 0.7)]),
    generate: generateReturning('Yes [1].'),
    documentsInProgress,
  });
  assert.equal(documentsInProgress.calls.length, 0);
});

test('top score below the floor: abstains without calling the model', async () => {
  const generate = generateReturning('unused');
  const r = await ask({ retrieve: retrieveReturning([chunk(1, ASK_MIN_SCORE - 0.01)]), generate });
  assert.equal(r.reason, 'below_score_floor');
  assert.equal(generate.calls.length, 0);
});

test('model sentinel becomes an abstention', async () => {
  const r = await ask({
    retrieve: retrieveReturning([chunk(1, 0.7)]),
    generate: generateReturning('INSUFFICIENT_CONTEXT'),
  });
  assert.equal(r.abstained, true);
  assert.equal(r.reason, 'model_insufficient_context');
  assert.equal(r.answer, ABSTAIN_MESSAGE);
});

test('uncited or wrongly cited answer becomes an abstention', async () => {
  const r = await ask({
    retrieve: retrieveReturning([chunk(1, 0.7)]),
    generate: generateReturning('The fee is 3% [4].'),
  });
  assert.equal(r.reason, 'no_valid_citations');
  assert.equal(r.trace.invalidMarkers, 1);
});

test('generator errors propagate unchanged', async () => {
  const generate = async () => {
    throw new AppError('The answer service timed out', 504, 'LLM_TIMEOUT');
  };
  await assert.rejects(ask({ retrieve: retrieveReturning([chunk(1, 0.7)]), generate }), {
    status: 504,
    code: 'LLM_TIMEOUT',
  });
});

const budgetRecorder = () => {
  const fn = async (tenantId) => {
    fn.calls.push(tenantId);
  };
  fn.calls = [];
  return fn;
};

test('LLM budget is consumed once per model call, with the tenant id', async () => {
  const consumeLlmBudget = budgetRecorder();
  await ask({
    retrieve: retrieveReturning([chunk(1, 0.7)]),
    generate: generateReturning('Yes [1].'),
    consumeLlmBudget,
  });
  assert.deepEqual(consumeLlmBudget.calls, ['t1']);
});

test('LLM budget is not consumed when abstaining before the model', async () => {
  const consumeLlmBudget = budgetRecorder();
  await ask({ retrieve: retrieveReturning([]), generate: generateReturning('unused'), consumeLlmBudget });
  await ask({
    retrieve: retrieveReturning([chunk(1, ASK_MIN_SCORE - 0.01)]),
    generate: generateReturning('unused'),
    consumeLlmBudget,
  });
  assert.equal(consumeLlmBudget.calls.length, 0);
});

test('exhausted LLM budget propagates and skips the model', async () => {
  const generate = generateReturning('unused');
  const consumeLlmBudget = async () => {
    throw new AppError('Daily question limit reached for this workspace', 429, 'LLM_BUDGET_EXCEEDED');
  };
  await assert.rejects(
    ask({ retrieve: retrieveReturning([chunk(1, 0.7)]), generate, consumeLlmBudget }),
    { status: 429, code: 'LLM_BUDGET_EXCEEDED' },
  );
  assert.equal(generate.calls.length, 0);
});

const unconfigured = () => getGenerator({});

test('missing LLM config is 503 LLM_NOT_CONFIGURED and spends no budget', async () => {
  const consumeLlmBudget = budgetRecorder();
  await assert.rejects(
    ask({ retrieve: retrieveReturning([chunk(1, 0.7)]), loadGenerator: unconfigured, consumeLlmBudget }),
    { status: 503, code: 'LLM_NOT_CONFIGURED' },
  );
  assert.equal(consumeLlmBudget.calls.length, 0);
});

test('abstentions before the model work without LLM config', async () => {
  const noDocs = await ask({ retrieve: retrieveReturning([]), loadGenerator: unconfigured });
  assert.equal(noDocs.reason, 'no_documents');
  const lowScore = await ask({
    retrieve: retrieveReturning([chunk(1, ASK_MIN_SCORE - 0.01)]),
    loadGenerator: unconfigured,
  });
  assert.equal(lowScore.reason, 'below_score_floor');
});

test('logs one line per ask with the decision and retrieval scores', async () => {
  const lines = [];
  await askQuestion(
    { tenantId: 't1', question: 'q' },
    {
      retrieve: retrieveReturning([chunk(1, 0.7)]),
      generate: generateReturning('Yes [1].'),
      documentsInProgress: noneInProgress,
      log: { info: (message, fields) => lines.push({ message, fields }) },
    },
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'ask completed');
  assert.equal(lines[0].fields.abstained, false);
  assert.deepEqual(lines[0].fields.cited, ['c1']);
  assert.deepEqual(lines[0].fields.retrieved, [{ chunkId: 'c1', score: 0.7 }]);
});
