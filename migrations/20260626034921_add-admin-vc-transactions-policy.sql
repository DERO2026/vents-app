-- Allow admins to read all vc_transactions rows
CREATE POLICY vc_transactions_admin_select
  ON vc_transactions
  FOR SELECT
  TO authenticated
  USING (is_admin());
