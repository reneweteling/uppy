import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

// Check if we're running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface FileInfo {
  key: string;
  size: number;
  last_modified: string;
  url: string;
}

interface UploadingFile {
  file: File;
  progress: number;
  status: "uploading" | "success" | "error" | "aborted";
  uploadSpeed: number; // bytes per second
  totalTime: number; // milliseconds
  remainingTime: number; // milliseconds
  startTime: number; // timestamp when upload started
  xhr?: XMLHttpRequest; // reference to abort the upload
  // Multipart upload specific fields
  isMultipart?: boolean;
  totalChunks?: number;
  chunkProgress?: Array<{
    partNumber: number;
    progress: number;
    status: "pending" | "uploading" | "completed" | "error";
    speed?: number;
  }>;
}

// Helper functions for formatting
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const formatTime = (milliseconds: number): string => {
  if (milliseconds < 1000) return "< 1s";
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

function App() {
  const [uploadedFiles, setUploadedFiles] = useState<FileInfo[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [editingFileKey, setEditingFileKey] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [appInfo, setAppInfo] = useState<{ version: string; bucket: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load files and app info on mount
  useEffect(() => {
    loadFiles();
    loadAppInfo();
  }, []);

  const loadAppInfo = async () => {
    try {
      if (isTauri) {
        const [version, bucket] = await invoke<[string, string]>("get_app_info");
        setAppInfo({ version, bucket });
      }
    } catch (error) {
      console.error("Failed to load app info:", error);
    }
  };

  // Add global drag event listeners
  useEffect(() => {
    const handleGlobalDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleGlobalDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Global drop detected", e.dataTransfer?.files);
    };

    // Add global event listeners
    document.addEventListener('dragover', handleGlobalDragOver);
    document.addEventListener('drop', handleGlobalDrop);

    // Cleanup
    return () => {
      document.removeEventListener('dragover', handleGlobalDragOver);
      document.removeEventListener('drop', handleGlobalDrop);
    };
  }, []);

  const loadFiles = async () => {
    try {
      setIsLoading(true);
      if (isTauri) {
        const files = await invoke<FileInfo[]>("list_uploaded_files");
        setUploadedFiles(files);
      } else {
        // Browser fallback - return empty array
        console.log("Running in browser - file list unavailable");
        setUploadedFiles([]);
      }
    } catch (error) {
      console.error("Failed to load files:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Drag enter detected", e.target);
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Drag leave detected", e.target);
    // Only set dragging to false if we're leaving the main container
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Drag over detected");
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Drop detected", e.dataTransfer.files);
    console.log("Drop target:", e.target);
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    console.log("Files to upload:", files);
    if (files.length > 0) {
      await handleFiles(files);
    } else {
      console.log("No files in drop event");
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      await handleFiles(files);
    }
  };

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      await uploadFile(file);
    }
  };

  const abortUpload = (file: File) => {
    setUploadingFiles((prev) => {
      const updatedFiles = prev.map((uf) => {
        if (uf.file === file && uf.xhr) {
          uf.xhr.abort();
          return { ...uf, status: "aborted" as const };
        }
        return uf;
      });
      return updatedFiles;
    });

    // Remove from uploading after a delay
    setTimeout(() => {
      setUploadingFiles((prev) => prev.filter((uf) => uf.file !== file));
    }, 1000);
  };

  const uploadFile = async (file: File) => {
    const startTime = Date.now();
    const uploadingFile: UploadingFile = {
      file,
      progress: 0,
      status: "uploading",
      uploadSpeed: 0,
      totalTime: 0,
      remainingTime: 0,
      startTime,
    };

    setUploadingFiles((prev) => [...prev, uploadingFile]);

    // Check if we're in browser - cannot upload without Tauri
    if (!isTauri) {
      console.error("Cannot upload in browser - Tauri required");
      setUploadingFiles((prev) =>
        prev.map((uf) => (uf.file === file ? { ...uf, status: "error" } : uf))
      );
      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((uf) => uf.file !== file));
      }, 2000);
      return;
    }

    try {
      // Use multipart upload for files larger than 5MB, otherwise use simple upload
      const useMultipart = file.size > 5 * 1024 * 1024; // 5MB threshold

      if (useMultipart) {
        await uploadFileMultipart(file, startTime);
      } else {
        await uploadFileSimple(file, startTime);
      }

      // Send notification
      await sendNotification({
        title: "Upload Complete",
        body: `${file.name} has been uploaded successfully`,
      });

      // Reload files
      await loadFiles();

      // Remove from uploading after a delay
      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((uf) => uf.file !== file));
      }, 2000);
    } catch (error) {
      console.error("Upload failed:", error);
      setUploadingFiles((prev) =>
        prev.map((uf) => (uf.file === file ? { ...uf, status: "error" } : uf))
      );
      await sendNotification({
        title: "Upload Failed",
        body: `Failed to upload ${file.name}`,
      });
    }
  };

  const uploadFileSimple = async (file: File, startTime: number) => {
    // Generate presigned POST URL
    const response = await invoke<{
      url: string;
      fields: Record<string, string>;
      file_url: string;
      key: string;
    }>("generate_presigned_post", {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    });

    // Upload file to S3 using XMLHttpRequest for progress tracking
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const progress = (e.loaded / e.total) * 100;
          const currentTime = Date.now();
          const elapsedTime = currentTime - startTime;
          const uploadSpeed = e.loaded / (elapsedTime / 1000); // bytes per second
          const remainingBytes = e.total - e.loaded;
          const remainingTime = uploadSpeed > 0 ? (remainingBytes / uploadSpeed) * 1000 : 0; // milliseconds

          setUploadingFiles((prev) =>
            prev.map((uf) =>
              uf.file === file ? {
                ...uf,
                progress,
                uploadSpeed,
                totalTime: elapsedTime,
                remainingTime,
                xhr
              } : uf
            )
          );
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadingFiles((prev) =>
            prev.map((uf) =>
              uf.file === file ? { ...uf, status: "success" } : uf
            )
          );
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.statusText}`));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Network error"));
      });

      xhr.open("PUT", response.url);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.send(file);
    });

    // Set ACL to public read after successful upload
    try {
      console.log("Setting ACL for uploaded file:", response.key);
      await invoke("set_object_acl", { key: response.key });
      console.log("ACL set successfully");
    } catch (aclError) {
      console.warn("Failed to set ACL, but upload was successful:", aclError);
    }
  };

  const uploadFileMultipart = async (file: File, startTime: number) => {
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    console.log(`Starting multipart upload: ${file.name} (${totalChunks} chunks)`);

    // Initialize chunk progress tracking
    const chunkProgress = Array.from({ length: totalChunks }, (_, i) => ({
      partNumber: i + 1,
      progress: 0,
      status: "pending" as const,
      speed: 0,
    }));

    // Update the uploading file with multipart info
    setUploadingFiles((prev) =>
      prev.map((uf) =>
        uf.file === file
          ? {
            ...uf,
            isMultipart: true,
            totalChunks,
            chunkProgress,
          }
          : uf
      )
    );

    // Initiate multipart upload
    const [uploadId, key] = await invoke<[string, string]>("initiate_multipart_upload", {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    });

    const uploadedParts: Array<{ partNumber: number; etag: string }> = [];

    // Upload all chunks in parallel
    const uploadPromises = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const partNumber = i + 1;

      console.log(`Preparing part ${partNumber}/${totalChunks}`);

      // Create upload promise for this chunk
      const uploadPromise = (async () => {
        // Get presigned URL for this part
        const presignedUrl = await invoke<string>("generate_presigned_url_for_part", {
          uploadId: uploadId,
          partNumber: partNumber,
          key: key,
        });

        console.log(`Starting upload of part ${partNumber}/${totalChunks}`);

        // Upload the chunk
        const etag = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              // Update progress for this specific chunk
              const chunkProgressPercent = (e.loaded / e.total) * 100;
              const chunkSize = chunk.size;
              const chunkUploaded = (e.loaded / e.total) * chunkSize;
              const currentTime = Date.now();
              const elapsedTime = currentTime - startTime;
              const chunkSpeed = chunkUploaded / (elapsedTime / 1000);

              // Update individual chunk progress
              setUploadingFiles((prev) =>
                prev.map((uf) => {
                  if (uf.file === file && uf.chunkProgress) {
                    // Update this specific chunk
                    const updatedChunkProgress = uf.chunkProgress.map((chunk) =>
                      chunk.partNumber === partNumber
                        ? {
                          ...chunk,
                          progress: chunkProgressPercent,
                          status: "uploading" as const,
                          speed: chunkSpeed,
                        }
                        : chunk
                    );

                    // Calculate overall progress across all chunks
                    const totalUploadedBytes = updatedChunkProgress.reduce((total, chunk) => {
                      const chunkSizeBytes = Math.min(CHUNK_SIZE, file.size - (chunk.partNumber - 1) * CHUNK_SIZE);
                      return total + (chunk.progress / 100) * chunkSizeBytes;
                    }, 0);

                    const overallProgress = (totalUploadedBytes / file.size) * 100;
                    const overallSpeed = totalUploadedBytes / (elapsedTime / 1000);
                    const remainingBytes = file.size - totalUploadedBytes;
                    const remainingTime = overallSpeed > 0 ? (remainingBytes / overallSpeed) * 1000 : 0;

                    return {
                      ...uf,
                      progress: overallProgress,
                      uploadSpeed: overallSpeed,
                      totalTime: elapsedTime,
                      remainingTime,
                      chunkProgress: updatedChunkProgress,
                    };
                  }
                  return uf;
                })
              );
            }
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              const etag = xhr.getResponseHeader("ETag") || "";

              // Mark chunk as completed
              setUploadingFiles((prev) =>
                prev.map((uf) => {
                  if (uf.file === file && uf.chunkProgress) {
                    const updatedChunkProgress = uf.chunkProgress.map((chunk) =>
                      chunk.partNumber === partNumber
                        ? { ...chunk, status: "completed" as const, progress: 100 }
                        : chunk
                    );
                    return { ...uf, chunkProgress: updatedChunkProgress };
                  }
                  return uf;
                })
              );

              resolve(etag.replace(/"/g, "")); // Remove quotes from ETag
            } else {
              // Mark chunk as error
              setUploadingFiles((prev) =>
                prev.map((uf) => {
                  if (uf.file === file && uf.chunkProgress) {
                    const updatedChunkProgress = uf.chunkProgress.map((chunk) =>
                      chunk.partNumber === partNumber
                        ? { ...chunk, status: "error" as const }
                        : chunk
                    );
                    return { ...uf, chunkProgress: updatedChunkProgress };
                  }
                  return uf;
                })
              );
              reject(new Error(`Part upload failed: ${xhr.statusText}`));
            }
          });

          xhr.addEventListener("error", () => {
            reject(new Error("Network error"));
          });

          xhr.open("PUT", presignedUrl);
          xhr.send(chunk);
        });

        console.log(`Part ${partNumber} uploaded successfully`);
        return { partNumber, etag };
      })();

      uploadPromises.push(uploadPromise);
    }

    // Wait for all uploads to complete
    console.log(`Waiting for all ${totalChunks} parts to complete...`);
    const results = await Promise.all(uploadPromises);

    // Sort results by part number to ensure correct order
    results.sort((a, b) => a.partNumber - b.partNumber);
    uploadedParts.push(...results);

    // Complete multipart upload
    console.log("Completing multipart upload...");
    const fileUrl = await invoke<string>("complete_multipart_upload", {
      uploadId: uploadId,
      key: key,
      parts: uploadedParts.map(p => [p.partNumber, p.etag] as [number, string]),
    });

    console.log("Multipart upload completed:", fileUrl);

    // Mark as success
    setUploadingFiles((prev) =>
      prev.map((uf) =>
        uf.file === file ? { ...uf, status: "success" } : uf
      )
    );
  };

  const handleDelete = async (key: string) => {
    console.log("handleDelete called with key:", key);
    setFileToDelete(key);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!fileToDelete) return;

    console.log("User confirmed deletion");
    try {
      console.log("Deleting file with key:", fileToDelete);
      if (!isTauri) {
        console.error("Not in Tauri - cannot invoke delete");
        return;
      }

      await invoke("delete_file", { key: fileToDelete });
      console.log("File deleted successfully, reloading files...");
      await loadFiles();
      await sendNotification({
        title: "File Deleted",
        body: "File has been deleted successfully",
      });
    } catch (error) {
      console.error("Failed to delete file:", error);
      await sendNotification({
        title: "Delete Failed",
        body: `Failed to delete file: ${error}`,
      });
    } finally {
      setShowDeleteConfirm(false);
      setFileToDelete(null);
    }
  };

  const cancelDelete = () => {
    console.log("User cancelled deletion");
    setShowDeleteConfirm(false);
    setFileToDelete(null);
  };

  const handleShare = async (url: string) => {
    try {
      console.log("Attempting to copy URL to clipboard:", url);
      await writeText(url);
      console.log("URL copied to clipboard successfully");
      await sendNotification({
        title: "Copied to Clipboard",
        body: "File URL has been copied to clipboard",
      });
      console.log("Notification sent successfully");
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const handleRename = async (oldKey: string, newName: string) => {
    if (!newName.trim()) return;

    // Extract timestamp and extension from old key
    const match = oldKey.match(/^(\d+)_(.+)$/);
    if (!match) return;

    const [, timestamp] = match;
    const newKey = `${timestamp}_${newName}`;

    try {
      await invoke("rename_file", { oldKey, newKey });
      setEditingFileKey(null);
      setEditingFileName("");
      await loadFiles();
    } catch (error) {
      console.error("Failed to rename file:", error);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const getFileNameFromKey = (key: string) => {
    const match = key.match(/^\d+_(.+)$/);
    return match ? match[1] : key;
  };

  return (
    <div className="min-h-screen h-full bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 bg-fixed">
      <div
        className={`w-full h-screen ${isDragging ? "opacity-50" : "opacity-100"
          } transition-opacity duration-200`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="fixed inset-0 z-50 bg-blue-500 bg-opacity-20 flex items-center justify-center">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-8 shadow-lg border-2 border-dashed border-blue-500">
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-blue-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Drop files here to upload
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Delete confirmation modal */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-50 bg-black bg-opacity-50 flex items-center justify-center">
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg max-w-md w-full mx-4">
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-red-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Delete File
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                  Are you sure you want to delete this file? This action cannot be undone.
                </p>
                <div className="flex space-x-3">
                  <button
                    onClick={cancelDelete}
                    className="flex-1 bg-gray-300 hover:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 px-4 py-2 rounded text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDelete}
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="container mx-auto px-4 py-8 max-w-6xl">
          <h1 className="text-4xl font-bold text-center mb-8 text-gray-800 dark:text-gray-200">
            Uppy S3 Uploader
          </h1>

          {/* Upload Area */}
          <div
            className={`border-2 border-dashed rounded-lg p-8 mb-8 text-center transition-colors ${isDragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
              : "border-gray-300 dark:border-gray-700 hover:border-gray-400"
              }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              stroke="currentColor"
              fill="none"
              viewBox="0 0 48 48"
            >
              <path
                d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Drag and drop files here, or click to select
            </p>
          </div>

          {/* Uploading Files */}
          {uploadingFiles.length > 0 && (
            <div className="mb-6 space-y-2">
              <h2 className="text-xl font-semibold mb-3 text-gray-700 dark:text-gray-300">
                Uploading...
              </h2>
              {uploadingFiles.map((uf) => (
                <div
                  key={`${uf.file.name}-${uf.file.lastModified}`}
                  className="bg-white dark:bg-gray-800 rounded-lg shadow p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {uf.file.name}
                    </span>
                    <div className="flex items-center space-x-2">
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {Math.round(uf.progress)}%
                      </span>
                      {uf.status === "uploading" && (
                        <button
                          onClick={() => abortUpload(uf.file)}
                          className="text-red-500 hover:text-red-700 text-sm font-medium"
                        >
                          Abort
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-2">
                    <div
                      className={`h-2 rounded-full transition-all ${uf.status === "success"
                        ? "bg-green-500"
                        : uf.status === "error"
                          ? "bg-red-500"
                          : uf.status === "aborted"
                            ? "bg-gray-500"
                            : "bg-blue-500"
                        }`}
                      style={{ width: `${uf.progress}%` }}
                    />
                  </div>
                  {uf.status === "uploading" && (
                    <div>
                      <div className="grid grid-cols-3 gap-4 text-xs text-gray-500 dark:text-gray-400 mb-3">
                        <div>
                          <span className="font-medium">Speed:</span>
                          <br />
                          {formatBytes(uf.uploadSpeed)}/s
                        </div>
                        <div>
                          <span className="font-medium">Time:</span>
                          <br />
                          {formatTime(uf.totalTime)}
                        </div>
                        <div>
                          <span className="font-medium">Remaining:</span>
                          <br />
                          {formatTime(uf.remainingTime)}
                        </div>
                      </div>

                      {/* Individual chunk progress for multipart uploads */}
                      {uf.isMultipart && uf.chunkProgress && (
                        <div className="mt-3">
                          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                            Parts ({uf.chunkProgress.filter(c => c.status === "completed").length}/{uf.totalChunks} completed):
                          </div>
                          <div className="grid grid-cols-5 gap-1">
                            {uf.chunkProgress.map((chunk) => (
                              <div
                                key={chunk.partNumber}
                                className={`h-2 rounded text-xs flex items-center justify-center ${chunk.status === "completed"
                                  ? "bg-green-500 text-white"
                                  : chunk.status === "uploading"
                                    ? "bg-blue-500 text-white"
                                    : chunk.status === "error"
                                      ? "bg-red-500 text-white"
                                      : "bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
                                  }`}
                                title={`Part ${chunk.partNumber}: ${Math.round(chunk.progress)}% - ${chunk.status}`}
                              >
                                {chunk.status === "completed" ? "✓" :
                                  chunk.status === "uploading" ? Math.round(chunk.progress) + "%" :
                                    chunk.status === "error" ? "✗" : chunk.partNumber}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {uf.status === "aborted" && (
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      Upload aborted
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* File List */}
          {isLoading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
            </div>
          ) : uploadedFiles.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <p className="text-lg">No files uploaded yet</p>
              <p className="text-sm mt-2">Drag and drop files to get started</p>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-4 text-gray-700 dark:text-gray-300">
                Uploaded Files
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {uploadedFiles.map((file) => (
                  <div
                    key={file.key}
                    className="bg-white dark:bg-gray-800 rounded-lg shadow hover:shadow-lg transition-shadow p-4"
                    onClick={() => {
                      // If we're editing this file and click outside the input, finalize the rename
                      if (editingFileKey === file.key) {
                        console.log("Clicked outside input - finalizing rename");
                        handleRename(file.key, editingFileName);
                      }
                    }}
                  >
                    {/* File Icon */}
                    <div className="flex items-center mb-3">
                      <svg
                        className="h-10 w-10 text-blue-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                    </div>

                    {/* File Name */}
                    {editingFileKey === file.key ? (
                      <div className="relative">
                        <input
                          type="text"
                          value={editingFileName}
                          onChange={(e) => setEditingFileName(e.target.value)}
                          onBlur={() => {
                            console.log("Input blurred - finalizing rename");
                            // Small delay to allow other events to complete first
                            setTimeout(() => {
                              handleRename(file.key, editingFileName);
                            }, 100);
                          }}
                          onClick={(e) => {
                            // Prevent clicks on the input from bubbling up
                            e.stopPropagation();
                          }}
                          onKeyDown={(e) => {
                            console.log("KeyDown - Key:", e.key, "KeyCode:", e.keyCode, "Code:", e.code);
                            if (e.key === "Enter" || e.key === "Return" || e.keyCode === 13) {
                              e.preventDefault();
                              e.stopPropagation();
                              console.log("Finalizing rename with Enter/Return (KeyDown)");
                              handleRename(file.key, editingFileName);
                            } else if (e.key === "Escape" || e.keyCode === 27) {
                              e.preventDefault();
                              e.stopPropagation();
                              console.log("Canceling rename with Escape (KeyDown)");
                              setEditingFileKey(null);
                              setEditingFileName("");
                            }
                          }}
                          onKeyPress={(e) => {
                            console.log("KeyPress - Key:", e.key, "KeyCode:", e.keyCode, "Code:", e.code);
                            if (e.key === "Enter" || e.key === "Return" || e.keyCode === 13) {
                              e.preventDefault();
                              e.stopPropagation();
                              console.log("Finalizing rename with Enter/Return (KeyPress)");
                              handleRename(file.key, editingFileName);
                            }
                          }}
                          onKeyUp={(e) => {
                            console.log("KeyUp - Key:", e.key, "KeyCode:", e.keyCode, "Code:", e.code);
                            if (e.key === "Enter" || e.key === "Return" || e.keyCode === 13) {
                              e.preventDefault();
                              e.stopPropagation();
                              console.log("Finalizing rename with Enter/Return (KeyUp)");
                              handleRename(file.key, editingFileName);
                            }
                          }}
                          className="w-full px-2 py-1 border border-blue-500 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-gray-900"
                          autoFocus
                        />
                      </div>
                    ) : (
                      <h3
                        className="font-medium text-gray-900 dark:text-white mb-1 truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                        onDoubleClick={() => {
                          setEditingFileKey(file.key);
                          setEditingFileName(getFileNameFromKey(file.key));
                        }}
                        title="Double-click to rename"
                      >
                        {getFileNameFromKey(file.key)}
                      </h3>
                    )}

                    {/* File Size */}
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                      {formatFileSize(file.size)}
                    </p>

                    {/* Actions */}
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          console.log("Download button clicked for:", file.url);
                          try {
                            await openUrl(file.url);
                            console.log("File opened successfully with Tauri opener");
                          } catch (error) {
                            console.error("Failed to open file:", error);
                            await sendNotification({
                              title: "Download Failed",
                              body: `Failed to open file: ${error}`,
                            });
                          }
                        }}
                        className="flex-1 bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded text-sm font-medium transition-colors flex items-center justify-center"
                      >
                        <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Download
                      </button>
                      <button
                        onClick={async () => {
                          console.log("Share button clicked for:", file.url);
                          try {
                            await handleShare(file.url);
                            console.log("Share function completed successfully");
                          } catch (error) {
                            console.error("Share function failed:", error);
                          }
                        }}
                        className="bg-blue-500 hover:bg-blue-600 text-white p-2 rounded text-sm font-medium transition-colors flex items-center justify-center"
                        title="Copy link to clipboard"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          console.log("Delete button clicked for key:", file.key);
                          handleDelete(file.key);
                        }}
                        className="bg-red-500 hover:bg-red-600 text-white p-2 rounded text-sm font-medium transition-colors flex items-center justify-center"
                        title="Delete file"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {appInfo && (
          <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 py-2 px-4">
            <div className="container mx-auto max-w-6xl flex justify-center">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                v{appInfo.version} • {appInfo.bucket}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
