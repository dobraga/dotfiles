# A/B Testing Standards

## Design & Execution
- Check for pre-experiment group balance (SRM test)
- Use the correct statistical test for the metric type (t-test, Mann-Whitney, chi-squared)
- Report effect sizes, not just p-values
- Correct for multiple comparisons (Bonferroni or FDR)
- Check for novelty effects in time-series data
- Never stop early based on peeking — use sequential testing or pre-commit to a sample size
