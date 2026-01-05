// @ts-check
import {defineConfig} from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
	integrations: [
		react(),
		starlight({
			title: 'VibeRAG',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/mdrideout/viberag',
				},
			],
			sidebar: [
				{
					label: 'Getting Started',
					slug: 'docs',
				},
				{
					label: 'Guides',
					autogenerate: {directory: 'docs/guides'},
				},
				{
					label: 'Reference',
					autogenerate: {directory: 'docs/reference'},
				},
			],
			customCss: ['./src/styles/global.css'],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
