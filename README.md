[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# Backport GitHub Action

A GitHub Action that automatically cherry-picks merged pull requests onto one or more target branches based on labels.

## How it works

1. A pull request is merged on your default branch.
2. The action detects labels matching a configurable prefix (e.g. `backport-to-production`).
3. A new PR with the cherry-picked commits is opened against each matched branch.

## Quick start

Create `.github/workflows/backport.yml` in your repository:

```yaml
name: Backport

on:
  pull_request_target:
    types: [labeled, closed]

jobs:
  backport:
    name: Backport PR
    if: |
      github.event.pull_request.merged == true &&
      !(contains(github.event.pull_request.labels.*.name, 'backport'))
    runs-on: ubuntu-latest
    steps:
      - name: Run backport
        uses: step-security/backport-github-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          auto_backport_label_prefix: backport-to-

      - name: Print info log
        if: success()
        run: cat ~/.backport/backport.info.log

      - name: Print debug log
        if: failure()
        run: cat ~/.backport/backport.debug.log
```

Add the label `backport-to-production` to any pull request. Once merged, a backport PR targeting `production` is created automatically.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `github_token` | Yes | — | GitHub token for creating backport PRs and API calls |
| `auto_backport_label_prefix` | No | — | Label prefix that maps to a target branch (e.g. `backport-to-`) |
| `repo_fork_owner` | No | Repository owner | Owner of the fork where backport branches are pushed |
| `add_original_reviewers` | No | `false` | Copy reviewers from the source PR to backport PRs |
| `ignore_error_codes` | No | `merge-conflict-exception,no-branches-exception` | Comma-separated error codes to suppress |

## Advanced configuration

For finer control, add a `.backportrc.json` to the repository root:

```json
{
  "repoOwner": "my-org",
  "repoName": "my-repo",
  "targetBranches": ["production"],
  "targetBranchChoices": ["main", "production", "staging"],
  "branchLabelMapping": {
    "^backport-to-(.+)$": "$1"
  }
}
```

## Error handling

Two error codes are suppressed by default:

| Code | Reason |
|------|--------|
| `merge-conflict-exception` | Conflicts are surfaced via a status comment on the source PR |
| `no-branches-exception` | Fires on every merged PR without backport labels |

Every other error fails the workflow run. To change this behaviour, set `ignore_error_codes`:

```yaml
# Fail on all errors including merge conflicts
- uses: step-security/backport-github-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    auto_backport_label_prefix: backport-to-
    ignore_error_codes: ""
```

## License

[MIT](./LICENSE)
