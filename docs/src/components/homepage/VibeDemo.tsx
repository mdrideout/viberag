import React, {useState, useEffect, useRef} from 'react';

const ASCII_ART = `
  ██╗   ██╗ ██╗ ██████╗  ███████╗ ██████╗   █████╗   ██████╗
  ██║   ██║ ██║ ██╔══██╗ ██╔════╝ ██╔══██╗ ██╔══██╗ ██╔════╝
  ██║   ██║ ██║ ██████╔╝ █████╗   ██████╔╝ ███████║ ██║  ███╗
  ╚██╗ ██╔╝ ██║ ██╔══██╗ ██╔══██╗ ██╔══██║ ██║  ██║ ██║   ██║
   ╚████╔╝  ██║ ██████╔╝ ███████╗ ██║  ██║ ██║  ██║ ╚██████╔╝
    ╚═══╝   ╚═╝ ╚═════╝  ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═════╝
`;

const TerminalDemo: React.FC = () => {
	const [history, setHistory] = useState<React.ReactNode[]>([]);
	const [activeStep, setActiveStep] = useState<number>(0);
	const [isProcessing, setIsProcessing] = useState(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const initialHistory = [
			<div
				key="ascii"
				className="text-transparent bg-clip-text bg-gradient-to-r from-[#9D4EDD] to-[#00D9FF] leading-none whitespace-pre select-none opacity-90 hidden md:block mb-6 font-bold"
			>
				{ASCII_ART}
			</div>,
			<div
				key="mobile-ascii"
				className="text-transparent bg-clip-text bg-gradient-to-r from-[#9D4EDD] to-[#00D9FF] leading-tight whitespace-pre select-none opacity-90 md:hidden mb-6 text-[8px] font-bold"
			>
				VIBERAG v0.3.0
			</div>,
			<div key="sys-info" className="space-y-1 mb-6 font-mono text-sm">
				<div className="flex items-center gap-3">
					<span className="text-slate-500">v0.3.0</span>
					<span className="text-[#00D9FF]">✓ System Ready</span>
				</div>
				<div className="text-slate-500">/Users/dev/repos/awesome-project</div>
			</div>,
			<div
				key="cmd-1"
				className="flex items-center gap-3 mb-2 font-mono text-sm"
			>
				<span className="text-[#00D9FF] font-bold">➜</span>
				<span className="text-slate-200">viberag init</span>
			</div>,
			<div key="info-1" className="text-slate-300 mb-1 font-mono text-sm">
				Initializing VibeRAG configuration wizard...
			</div>,
			<div key="info-2" className="text-slate-300 mb-6 font-mono text-sm">
				This utility will walk you through setting up semantic search for your
				codebase.
			</div>,
		];
		setHistory(initialHistory);
		setTimeout(() => setActiveStep(1), 500);
	}, []);

	useEffect(() => {
		if (scrollContainerRef.current) {
			scrollContainerRef.current.scrollTo({
				top: scrollContainerRef.current.scrollHeight,
				behavior: 'smooth',
			});
		}
	}, [history, isProcessing, activeStep]);

	const addToHistory = (node: React.ReactNode) => {
		setHistory(prev => [...prev, node]);
	};

	const handleProviderSelect = (provider: string) => {
		addToHistory(
			<div
				key={`ans-1-${Date.now()}`}
				className="mb-4 font-mono text-sm animate-fade-in"
			>
				<div className="text-[#9D4EDD] font-bold mb-1">
					? Select embedding provider:
				</div>
				<div className="text-[#00D9FF] flex items-center gap-2">
					<span>❯</span> {provider}
				</div>
			</div>,
		);
		setActiveStep(0);
		setIsProcessing(true);

		setTimeout(() => {
			const processingNodes = [
				<div key="p-1" className="text-slate-400 mt-2 font-mono text-sm">
					[*] Downloading Qwen3-0.6B (380MB)...{' '}
					<span className="text-green-400">Done</span>
				</div>,
				<div key="p-2" className="text-slate-400 font-mono text-sm">
					[*] Initializing Tree-sitter parser (TypeScript, Python, Go)...{' '}
					<span className="text-green-400">Done</span>
				</div>,
				<div key="p-3" className="text-slate-400 font-mono text-sm">
					[*] Generating embeddings for 142 files...
				</div>,
				<div
					key="p-4"
					className="text-slate-400 mb-4 flex items-center gap-2 font-mono text-sm"
				>
					<div className="w-32 h-2 bg-slate-800 rounded overflow-hidden">
						<div
							className="h-full bg-[#9D4EDD] animate-[width_1.5s_ease-out_forwards]"
							style={{width: '100%'}}
						></div>
					</div>
					<span className="text-xs">100%</span>
				</div>,
				<div
					key="p-5"
					className="text-green-400 mb-6 font-bold font-mono text-sm"
				>
					[+] Index created successfully in ./.viberag/lance_db
				</div>,
			];
			setHistory(prev => [...prev, ...processingNodes]);
			setIsProcessing(false);
			setActiveStep(2);
		}, 2000);
	};

	const handleMcpStart = () => {
		addToHistory(
			<div
				key={`ans-2-${Date.now()}`}
				className="mb-4 font-mono text-sm animate-fade-in"
			>
				<div className="text-[#9D4EDD] font-bold mb-1">
					? Configure MCP server now?
				</div>
				<div className="text-[#00D9FF] flex items-center gap-2">
					<span>❯</span> Yes
				</div>
			</div>,
		);
		setActiveStep(0);

		setTimeout(() => {
			addToHistory(
				<div key="info-mcp" className="text-slate-300 mb-2 font-mono text-sm">
					Scanning for compatible editors...
				</div>,
			);
			setActiveStep(3);
		}, 600);
	};

	const handleEditorSelect = (editor: string) => {
		addToHistory(
			<div
				key={`ans-3-${Date.now()}`}
				className="mb-4 font-mono text-sm animate-fade-in"
			>
				<div className="text-[#9D4EDD] font-bold mb-1">
					? Select target editor:
				</div>
				<div className="text-[#00D9FF] flex items-center gap-2">
					<span>❯</span> {editor}
				</div>
			</div>,
		);
		setActiveStep(0);
		setIsProcessing(true);

		setTimeout(() => {
			const finalNodes = [
				<div key="f-1" className="text-slate-400 mt-2 font-mono text-sm">
					[*] Analyzed configuration for {editor}...{' '}
					<span className="text-green-400">OK</span>
				</div>,
				<div key="f-2" className="text-slate-400 font-mono text-sm">
					[*] Injecting viberag server config...{' '}
					<span className="text-green-400">Success</span>
				</div>,
				<div
					key="f-3"
					className="text-[#00D9FF] mt-4 font-bold font-mono text-sm"
				>
					✔ Setup Complete
				</div>,
				<div key="f-4" className="text-slate-300 mb-1 font-mono text-sm">
					Your agent will automatically start viberag and watch for changes.
				</div>,
				<div
					key="f-5"
					className="flex items-center gap-3 mt-4 mb-2 font-mono text-sm"
				>
					<span className="text-[#00D9FF] font-bold">➜</span>
					<span className="animate-cursor w-2 h-4 bg-slate-500 inline-block"></span>
				</div>,
			];
			setHistory(prev => [...prev, ...finalNodes]);
			setIsProcessing(false);
			setActiveStep(4);
		}, 1200);
	};

	return (
		<div
			id="demo"
			className="w-full bg-[#0f1117] rounded-lg border border-slate-800 shadow-2xl overflow-hidden font-mono text-sm relative"
		>
			{/* Terminal Header */}
			<div className="bg-[#1a1d24] px-4 py-2 flex items-center justify-between border-b border-slate-800">
				<div className="flex gap-2">
					<div className="w-3 h-3 rounded-full bg-red-500/80" />
					<div className="w-3 h-3 rounded-full bg-yellow-500/80" />
					<div className="w-3 h-3 rounded-full bg-green-500/80" />
				</div>
				<div className="text-slate-500 text-xs font-sans">
					viberag — -zsh — 80x24
				</div>
				<div className="w-10" />
			</div>

			{/* Terminal Body */}
			<div
				className="p-6 h-[500px] overflow-y-auto custom-scrollbar relative bg-[#0f1117]"
				onClick={() => {}}
				ref={scrollContainerRef}
			>
				{history.map((node, i) => (
					<div key={i}>{node}</div>
				))}

				{/* Step 1: Provider Selection */}
				{activeStep === 1 && !isProcessing && (
					<div className="mb-4 animate-fade-in font-mono text-sm">
						<div className="text-[#9D4EDD] font-bold mb-2">
							? Select embedding provider:
						</div>
						<div className="flex flex-col gap-0">
							<button
								onClick={() => handleProviderSelect('Local (Qwen3)')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-[#00D9FF]">❯</span>
								<span className="text-[#00D9FF] w-16">Local</span>
								<span className="text-slate-500">-</span>
								<span className="text-slate-400">
									Qwen3-0.6B Q8 (~700MB, ~1.2GB RAM)
								</span>
							</button>
							<button
								onClick={() => handleProviderSelect('Gemini')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400 w-16">Gemini</span>
								<span className="text-slate-500">-</span>
								<span className="text-slate-500">
									gemini-embedding-001 (Free tier)
								</span>
							</button>
							<button
								onClick={() => handleProviderSelect('Mistral')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400 w-16">Mistral</span>
								<span className="text-slate-500">-</span>
								<span className="text-slate-500">codestral-embed</span>
							</button>
							<button
								onClick={() => handleProviderSelect('OpenAI')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400 w-16">OpenAI</span>
								<span className="text-slate-500">-</span>
								<span className="text-slate-500">text-embedding-3-large</span>
							</button>
						</div>
					</div>
				)}

				{/* Step 2: MCP Prompt */}
				{activeStep === 2 && !isProcessing && (
					<div className="mb-4 animate-fade-in font-mono text-sm">
						<div className="text-[#9D4EDD] font-bold mb-2">
							? Configure MCP server now? (Y/n)
						</div>
						<div className="flex flex-col gap-0">
							<button
								onClick={handleMcpStart}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-[#00D9FF]">❯</span>
								<span className="text-[#00D9FF]">Yes</span>
							</button>
							<button className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30">
								<span className="text-transparent">❯</span>
								<span className="text-slate-400">No</span>
							</button>
						</div>
					</div>
				)}

				{/* Step 3: Editor Selection */}
				{activeStep === 3 && !isProcessing && (
					<div className="mb-4 animate-fade-in font-mono text-sm">
						<div className="text-[#9D4EDD] font-bold mb-2">
							? Select target editor:
						</div>
						<div className="flex flex-col gap-0">
							<button
								onClick={() => handleEditorSelect('Claude Code')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-[#00D9FF]">❯</span>
								<span className="text-[#00D9FF]">Claude Code</span>
							</button>
							<button
								onClick={() => handleEditorSelect('Cursor')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400">Cursor</span>
							</button>
							<button
								onClick={() => handleEditorSelect('VS Code')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400">VS Code</span>
							</button>
							<button
								onClick={() => handleEditorSelect('Windsurf')}
								className="text-left bg-transparent px-2 py-0.5 transition-colors flex items-center gap-2 w-full hover:bg-slate-800/30"
							>
								<span className="text-transparent">❯</span>
								<span className="text-slate-400">Windsurf</span>
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
};

export default TerminalDemo;
