// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://nikiforovall.blog',
	base: '/claude-code-memory',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'Claude Code Memory Diagnoser',
			description: 'See every memory file Claude Code loads for a project, and find what is stale, false, or conflicting.',
			favicon: '/favicon.svg',
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://nikiforovall.blog/claude-code-memory/og.png' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://nikiforovall.blog/claude-code-memory/og.png' } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/NikiforovAll/claude-code-memory' }],
			editLink: { baseUrl: 'https://github.com/NikiforovAll/claude-code-memory/edit/main/website/' },
			customCss: ['./src/kit/kit.css'],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{ label: 'Start here', items: [{ label: 'Getting started', slug: 'getting-started' }] },
				{ label: 'Guides', items: [{ label: 'What Claude Code loads', slug: 'guides/memory-stack' }, { label: 'Browse memory files', slug: 'guides/browse' }, { label: 'Analyze memory with Claude', slug: 'guides/analyze' }] },
				{ label: 'Reference', items: [{ label: 'Keyboard shortcuts', slug: 'reference/shortcuts' }, { label: 'CLI and configuration', slug: 'reference/configuration' },{ label: 'Run inside Claude Code Hub', slug: 'reference/hub' }, { label: 'Troubleshooting', slug: 'reference/troubleshooting' }] },
			],
		}),
	],
});
