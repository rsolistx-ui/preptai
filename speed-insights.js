// Vercel Speed Insights initialization for static HTML
// This script should be loaded as a module: <script type="module" src="/speed-insights.js"></script>
import { injectSpeedInsights } from 'https://cdn.jsdelivr.net/npm/@vercel/speed-insights@2/+esm';

// Initialize Speed Insights
injectSpeedInsights({
  framework: 'vanilla'
});
