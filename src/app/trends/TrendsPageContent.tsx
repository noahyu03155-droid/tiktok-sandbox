// This file is unused dead code left over from an earlier project structure
// (the real component lives at src/components/TrendsPageContent.tsx and is
// what src/app/trends/page.tsx actually imports). It was never deleted, so
// `next build`'s typecheck still compiled it — and it still referenced
// translation keys that were removed during the FastMoss integration,
// breaking the build. Re-exporting the real component here keeps this file
// harmless without needing filesystem delete permissions.
export { default } from "@/components/TrendsPageContent";
