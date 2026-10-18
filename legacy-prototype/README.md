# Legacy prototype (superseded — do not deploy)

These files are the original single-file prototype that existed before the
rebuild. They are kept only for reference and are **not** imported by the app,
built, linted or deployed. In particular, `schema.sql` must **not** be run: it
stored all quiz state (including answer keys) in one row that any signed-in
user could overwrite. Use `supabase/migrations/` instead.

You can safely delete this folder.
