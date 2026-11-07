# Compact Connections design

**Intent:** Make a handful of persistent bank connections easy to scan and map without treating every institution as a large form.

**Approaches:** A dense table would make account mappings hard to read; retaining the existing cards leaves too much repeated space. The selected approach uses compact institution cards with an account-to-Actual mapping row, one small Save mapping action, and a disclosure for destructive/maintenance controls.

**Design:** The page header has a concise explanation and one Connect button. Each institution card shows its sync status and selected-account count, mapping rows in a two-column layout, and a compact action footer. Sync/reconnect stay visible; disconnect moves into a native disclosure. Mobile stacks each mapping row without changing behavior.

**Non-goals:** No changes to Plaid persistence, account mapping semantics, or sync behavior.
