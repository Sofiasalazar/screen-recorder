export function FooterCTA() {
  return (
    <footer className="px-6 py-4 border-t border-brand-border text-center text-xs text-brand-muted">
      Want this tool for your brand?{' '}
      <a
        href="mailto:info@agenticsis.top"
        className="text-brand-violet hover:text-brand-purple transition-colors font-medium"
      >
        info@agenticsis.top
      </a>
      {' '}&mdash; we build AI-powered tools for your business.
    </footer>
  );
}
