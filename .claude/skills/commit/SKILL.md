---
name: commit
description: Analyzes staged changes and generates a high-quality, conventional commit message, then executes the commit.
---

# Smart Commit Skill

When I say "commit this" or "generate a commit message," follow this workflow:

## 1. Intelligence Gathering
* **Run** `git diff --cached` to see exactly what is being committed.
* **Identify Change Type**: Determine if it is a `feat`, `fix`, `docs`, `style`, `refactor`, `test`, or `chore`.
* **Analyze Scope**: Identify the specific module or component affected (e.g., `api`, `models`, `ui`).

## 2. Generate the Message
Follow the **Conventional Commits** specification:

```text
<type>(<scope>): <short summary in imperative mood>

[optional body: explain the WHY, not just the WHAT]

[optional footer: relate to Issue IDs, e.g., Closes #123]

```

don't add Co-Authored-By on message

## 3. The Commit Flow (The Analogy)

Before finalizing, briefly explain the commit using your standard style:

### The Analogy

"This commit is like **[Insert Analogy]** (e.g., This commit is like updating the table of contents in a book; it doesn't change the story, but it makes finding the chapters much easier)."

```

## 4. Execution

1. **Present** the generated message to the user.
2. **Ask**: "Would you like me to execute this commit?"
3. If confirmed, **Run** `git commit -m "[message]"` (or `-m "[subject]" -m "[body]"` for multi-line).

## 5. The Gotcha

**Warning**: Remind the user if they are committing too many unrelated changes at once (non-atomic commits). If the diff is too large, suggest splitting it into two separate commits.

```

---

### Why this works for you
* **Context Aware**: Because it runs `git diff --cached`, it knows exactly what you've staged, unlike generic AI tools that look at your whole folder.
* **Structured**: It forces the "Conventional Commit" format, which makes your `git log` look professional and machine-readable.
* **Interactive**: It doesn't just run code blindly; it shows you the "Analogy" first to ensure you agree with its interpretation of your work.

### Example Interaction
**User:** "Claude, commit these Pydantic changes."

**Claude:**
> **The Analogy**: This commit is like swapping a "trust-based" handshake for a legal contract. We're no longer just *hoping* the data is right; we're validating it at the door.
> 
> **Proposed Message**:
> `feat(models): implement Pydantic v2 validation for User schema`
> 
> `Updated UserRecord to inherit from BaseModel and added EmailStr validation for the email field. This prevents malformed data from reaching the service layer.`
>
> **Would you like me to execute this commit?**

