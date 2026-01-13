"use client";

import { useState, useEffect } from "react";

interface OutputPanelProps {
  outputText: string;
  onOutputChange: (text: string) => void;
  isComplete: boolean;
}

export default function OutputPanel({
  outputText,
  onOutputChange,
  isComplete,
}: OutputPanelProps) {
  const [editedText, setEditedText] = useState(outputText);
  const [isCopied, setIsCopied] = useState(false);

  // outputTextが変更されたらeditedTextも更新
  useEffect(() => {
    setEditedText(outputText);
  }, [outputText]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editedText);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error("コピーに失敗しました:", err);
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setEditedText(newText);
    onOutputChange(newText);
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6 flex flex-col h-[calc(100vh-200px)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900">求人要件アウトプット</h2>
        <button
          onClick={handleCopy}
          disabled={!editedText.trim()}
          className={`px-4 py-2 rounded-lg font-semibold transition-colors ${
            isCopied
              ? "bg-green-500 text-white"
              : "bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
          }`}
        >
          {isCopied ? "✓ コピーしました" : "コピー"}
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <textarea
          value={editedText}
          onChange={handleTextChange}
          placeholder={isComplete ? "求人要件がここに表示されます..." : "質問に答えると、ここに求人要件が生成されます..."}
          className="w-full h-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-sm leading-relaxed"
          readOnly={!isComplete}
        />
      </div>

      {!isComplete && outputText && (
        <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
          <p className="text-sm text-yellow-800">
            ⚠️ 質問が完了するまで、アウトプットは自動更新されます。質問完了後に編集してください。
          </p>
        </div>
      )}
    </div>
  );
}
