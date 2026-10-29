import type React from "react"
import styled from "styled-components"

interface ChatLayoutProps {
    isHidden: boolean
    children: React.ReactNode
}

/**
 * Main layout container for the chat view
 * Provides the fixed positioning and flex layout structure
 */
export const ChatLayout: React.FC<ChatLayoutProps> = ({ isHidden, children }) => {
    return (
        <ChatLayoutContainer isHidden={isHidden}>
            <MainContent>{children}</MainContent>
        </ChatLayoutContainer>
    )
}

const ChatLayoutContainer = styled.div.withConfig({
    shouldForwardProp: (prop) => !["isHidden"].includes(prop),
})<{ isHidden: boolean }>`
	display: ${(props) => (props.isHidden ? "none" : "grid")};
	/* The messages row yields first: a bare 1fr keeps its content's min height
	   and pushes the composer below the clipped edge of a short or zoomed view. */
	grid-template-rows: minmax(0, 1fr) auto;
	overflow: hidden;
	padding: 0;
	margin: 0;
	width: 100%;
	height: 100%;
	min-height: 100vh;
	position: relative;
`

const MainContent = styled.div`
	display: flex;
	flex-direction: column;
	overflow: hidden;
	min-height: 0;
	grid-row: 1;
`
