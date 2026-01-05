import React, {useState, useEffect} from 'react';

const AgentDemo = () => {
	const [exampleIndex, setExampleIndex] = useState(0);
	const [charIndex, setCharIndex] = useState(0);
	const [isDeleting, setIsDeleting] = useState(false);
	const [isPaused, setIsPaused] = useState(false);

	const PREFIX = 'use viberag';
	const examples = [
		' to understand how websocket events update the ui state',
		' to find where we handle auth token refresh logic',
		' to plan a refactor of the billing service for multi-currency',
		' to find every place we validate user permissions',
		' to map out the dependency graph for the notification service',
	];

	useEffect(() => {
		const currentFullText = PREFIX + examples[exampleIndex];

		if (isPaused) {
			const timeout = setTimeout(() => {
				setIsPaused(false);
				setIsDeleting(true);
			}, 2500);
			return () => clearTimeout(timeout);
		}

		const timeoutDuration = isDeleting ? 15 : 30;

		const timeout = setTimeout(() => {
			if (!isDeleting) {
				if (charIndex < currentFullText.length) {
					setCharIndex(prev => prev + 1);
				} else {
					setIsPaused(true);
				}
			} else {
				if (charIndex > 0) {
					setCharIndex(prev => prev - 1);
				} else {
					setIsDeleting(false);
					setExampleIndex(prev => (prev + 1) % examples.length);
				}
			}
		}, timeoutDuration);

		return () => clearTimeout(timeout);
	}, [charIndex, isDeleting, isPaused, exampleIndex]);

	const prefixLength = Math.min(charIndex, PREFIX.length);
	const suffixLength = Math.max(0, charIndex - PREFIX.length);

	const displayedPrefix = PREFIX.slice(0, prefixLength);
	const displayedSuffix = examples[exampleIndex].slice(0, suffixLength);

	return (
		<div className="w-full bg-[#0f1117] rounded-xl border border-slate-800 shadow-2xl p-6 md:p-12 flex items-center min-h-[220px] relative overflow-hidden group">
			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4 bg-[#9D4EDD]/5 blur-[80px] rounded-full"></div>

			<div className="relative font-mono text-lg md:text-3xl font-bold leading-relaxed w-full text-left">
				<span className="text-slate-600 mr-3 hidden md:inline-block">&gt;</span>
				<span className="text-transparent bg-clip-text bg-gradient-to-r from-[#9D4EDD] to-[#00D9FF]">
					{displayedPrefix}
				</span>
				<span className="text-slate-200">{displayedSuffix}</span>
				<span className="animate-cursor inline-block w-2 h-5 md:w-3 md:h-8 bg-[#00D9FF] align-middle ml-1.5 rounded-sm opacity-80 shadow-[0_0_10px_#00D9FF]"></span>
			</div>
		</div>
	);
};

export default AgentDemo;
