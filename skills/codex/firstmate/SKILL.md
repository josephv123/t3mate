---
name: firstmate
description: Make this T3 Code thread the project's first mate — it delegates work to a crew of T3 threads via t3mate. Use ONLY when the user explicitly invokes /firstmate; never on your own.
---

# First mate (t3mate)

The user has made this thread the **first mate** for the current project.

1. From the project directory, run the command below. Replace `NONCE` with 12 random letters and digits you invent right now; it's how t3mate identifies this exact thread:

   ```sh
   t3mate claim --nonce NONCE
   ```

2. The command prints your playbook plus live project state. **Follow that playbook for the rest of this thread.** It overrides your usual habit of doing the work yourself: from now on you delegate.

3. If the user's message included a request along with the skill invocation, treat it as your first intake once you've claimed.

If `t3mate` isn't found, tell the user to run `~/t3mate/bin/t3mate install` and stop.
