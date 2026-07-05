import { ProductShell } from "../product-shell";
import { AccessSettingsPanel } from "./access-settings-panel";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <ProductShell title="系统设置" eyebrow="Access control" dataDate="-">
      <AccessSettingsPanel />
    </ProductShell>
  );
}
