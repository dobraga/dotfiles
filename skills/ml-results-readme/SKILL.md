---
name: ml-results-readme
description: Write or update the README of an ML experiment track (a classifier, an extractor, a ranker, any model compared across experiments). Gives the structure (data, production size and cost, main results, one experiment ladder per model) and the honesty rules. Use when the user asks to update, restructure or create a results README, an experiments table or a model-comparison summary.
---

# ML results README

A README of an experiment track answers four questions in this order: what data was used, what does it cost to run, which model is best, and what did each change do. The reader is a teammate who was not in the sessions. Numbers come from scripts that can be rerun, never typed from memory.

Before writing, read the existing README, `docs/tasks/todo.md` and `docs/tasks/lessons.md`, and the scripts that print the numbers. Change as little as needed to reach this structure; keep what is already correct.

## Structure

1. **Summary.** The question, the answer in two sentences, and the stop rule if one exists. Then the column definitions (what each metric and cost column means), at the top, so no table needs a footnote.
2. **Data.** One table of every dataset with its role: train, selection (cuts, thresholds, prompt wording, early stopping), test, hold-out. When there is more than one training set, give each its own row and its own letter, (a), (b), and so on, with the rows that combine or filter another set saying how ("(a) plus 451 files"); the letters are local to the README. For each row: size (files and pages or rows), how it was drawn, how it was labelled and by whom, and what no person has checked. State what each choice was fitted on, so a reader can see where a selection leak is possible. Say whose opinion the gold is.
3. **Production size and cost.** See "Cost" below. Short, only what changes a decision.
4. **Main results.** The best model of each size or kind, one table, the same columns for every row, sorted by cost with the cheapest first. Add the strongest outside readers (a hosted model, a baseline) as reference rows. Label each row with the model and a number only, for example "Qwen3.5-0.8B LoRA (1)": the configuration (learning rate, data size, seed) belongs in the experiment row with the same mark, not in the label.
5. **Experiments, one table per model.** One row is one experiment or change. Order the rows best first and worst last, by the metric of the problem (ties by a second metric, then by cost). Columns: what changed, the result, the cost, and a short note. There is no separate data column: end the change text with the training set's letter from the Data table in parentheses, for example "lr 8e-4 (b)", "seed 2 (a + b)" or "lr 2e-4 (a, 25%)", and write nothing for a model that was not trained. Mark the row that feeds the main table with its number, for example **(1)**. Close each table with one line: the best row and what moved it most.
6. **What we learned and what is open.** Findings that change what to do next, the parts still a guess, and the next experiments with their cost.

## Honesty rules

- Print the noise first: the seed spread, or the spread across reruns, above every experiment table. Rows within it of the top row are tied: say so in their note and do not present the top one as better.
- Name the gold. If a model made it, or no person checked it, say so next to the table, and say which readers could be favoured by it.
- A failed or null experiment is one short row ("no gain"), never deleted. It stops the team repeating it.
- Leave out any result from a run known to be invalid (a broken serve, a wrong merge, a leak). Note it in `lessons.md`, not in the table.
- Separate what was measured from what is estimated or guessed. Say how many runs, seeds and items each number rests on.
- Selection on the test set is a leak. If a choice was made on it, say so in the row.
- No marketing words. State the number, the set, and the comparison.
- **One home per fact.** A cost, a set size or a recipe is written in one section; the others point to it. A section that only repeats others is removed.
- **Define a term where it first appears.** Any rule, strategy or metric that a row relies on gets a one-line definition at the top of the section that uses it, or in the summary's column definitions.
- **No status words in row labels.** A label says what the row is; "(production)", "best" or "new" mix in how it is used and go stale. The mark (n) links a row to the main table, and a note can say which row runs in production.
- **State what is measured, not what is planned.** No "in progress" or "queued" lines in a README; open work goes in the "What is open" section with its cost.

## Cost

The cost rules depend on the problem. Choose the unit and the volume from the problem, and write the choice down; do not copy another project's columns.

1. **Pick the unit that the decision uses.** Per page for document pipelines, per document or file when a unit is read as a whole, per request or per 1,000 tokens for text models, per 1,000 items for ranking or tagging, per hour of audio for speech. If a strategy reads a variable amount per item (all pages against the first page, a retry, an escalation to a bigger model), report the cost per item for each strategy, not only per unit.
2. **State where the volume comes from** (a ticket, a measured count, an estimate) and the assumed mix. Report the monthly cost at that volume, and the one-off cost of any backlog if there is one. If no volume is known, say so and give the unit cost only; do not invent a volume.
3. **State the serving mode.** Batch (a job that starts, runs and stops) and online (an endpoint that is up) have different costs: an online endpoint pays for idle time. If the requirement is unknown, give the batch number and say what online would add.
4. **Measure, do not price-list.** Take tokens, pages and GPU seconds from the runs, and the price from the billing source. Mark any price that is an assumption.
5. **One-off costs go next to the result when two models are close:** training per run, labelling, and any human review. They are not part of the per-unit cost.
6. **Cost of the whole pipeline, if there are stages.** When a cheap stage decides which items reach a costly stage, give the cost of the whole chain at the measured routing mix, not the cost of each stage alone.
7. Leave a cost column out if it cannot change a decision for this problem, and say why in one line.

## Process

1. Write the plan for the README change in `docs/tasks/todo.md` first, if the project's rules ask for it, and agree the structure with the user before changing a README that others read.
2. Generate numbers with the project's scripts (add a small script if none exists, runnable as a module). Do not paste numbers that no command printed.
3. Keep the column definitions, labels and rounding the same in every table. Label rows consistently: "<model> LoRA (n)" in the main table, the same (n) on the matching row of the experiment table.
4. After the change, run the project's formatter on any script touched, and check that every number in the summary table appears in an experiment row.
5. Do not commit or push unless the user asks.
