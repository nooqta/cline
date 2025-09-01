import React from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
	crewBanner?: {
		crewName: string
		agentCount: number
		agentsEnabled: number
		overridesCount: number
		providerOverride: boolean
	}
}

/**
 * Input section including quoted message preview and chat text area
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
	crewBanner,
}) => {
	const {
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior

	return (
		<>
			{crewBanner && (
				<div
					style={{
						marginTop: "6px",
						marginBottom: "4px",
						padding: "6px 10px",
						border: "1px solid var(--vscode-editorWidget-border)",
						borderRadius: 4,
						fontSize: "12px",
						display: "flex",
						alignItems: "center",
						gap: "8px",
						background: "var(--vscode-editor-background)",
					}}>
					<span style={{ fontWeight: 600 }}>Crew Mode: {crewBanner.crewName}</span>
					<span>
						({crewBanner.agentsEnabled}/{crewBanner.agentCount} active)
					</span>
					{crewBanner.providerOverride && <span>provider override</span>}
					{crewBanner.overridesCount > 0 && <span>{crewBanner.overridesCount} agent overrides</span>}
					<button
						onClick={() => {
							// Navigate to settings and scroll to crew section if supported
							try {
								// Optional RPC if implemented; falls back to dispatch event
								// @ts-ignore
								if (window.UiServiceClient?.scrollToSettings) {
									// @ts-ignore
									window.UiServiceClient.scrollToSettings({ value: "crew" })
								}
							} catch {}
							window.dispatchEvent(new CustomEvent("clineNavigateSettings", { detail: { section: "crew" } }))
						}}
						style={{
							marginLeft: "auto",
							fontSize: "11px",
							cursor: "pointer",
							background: "var(--vscode-button-secondaryBackground)",
							color: "var(--vscode-button-secondaryForeground)",
							border: "1px solid var(--vscode-button-border, transparent)",
							padding: "2px 8px",
							borderRadius: 3,
						}}>
						Manage
					</button>
				</div>
			)}
			{activeQuote && (
				<div style={{ marginBottom: "-12px", marginTop: "10px" }}>
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ChatTextArea
				activeQuote={activeQuote}
				inputValue={inputValue}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				placeholderText={placeholderText}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={sendingDisabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
			/>
		</>
	)
}
