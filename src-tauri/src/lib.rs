use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::config::Credentials as S3Credentials;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client as S3Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
struct PresignedPostResponse {
    url: String,
    fields: HashMap<String, String>,
    file_url: String,
    key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileInfo {
    key: String,
    size: i64,
    last_modified: String,
    url: String,
}

#[tauri::command]
async fn generate_presigned_post(
    filename: String,
    content_type: String,
) -> Result<PresignedPostResponse, String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("{}_{}", timestamp, filename);

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);
    let presigning_config = PresigningConfig::expires_in(Duration::from_secs(3600))
        .map_err(|e| format!("Failed to create presigning config: {}", e))?;

    let presigned_request = client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .content_type(&content_type)
        .presigned(presigning_config)
        .await
        .map_err(|e| format!("Failed to create presigned request: {}", e))?;

    let mut fields = HashMap::new();
    fields.insert("key".to_string(), key.clone());
    fields.insert("Content-Type".to_string(), content_type);

    let file_url = format!("https://s3.{}.amazonaws.com/{}/{}", aws_region, bucket, key);

    Ok(PresignedPostResponse {
        url: presigned_request.uri().to_string(),
        fields,
        file_url,
        key,
    })
}

#[tauri::command]
async fn list_uploaded_files() -> Result<Vec<FileInfo>, String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    let list_objects_output = client
        .list_objects_v2()
        .bucket(&bucket)
        .send()
        .await
        .map_err(|e| format!("Failed to list objects: {}", e))?;

    let mut files = Vec::new();

    let objects = list_objects_output.contents();
    for object in objects {
        if let Some(key) = object.key() {
            let size = object.size().unwrap_or(0);
            let last_modified = object.last_modified()
                .map(|t| t.to_string())
                .unwrap_or_else(|| "Unknown".to_string());
            let url = format!("https://s3.{}.amazonaws.com/{}/{}", aws_region, bucket, key);

            files.push(FileInfo {
                key: key.to_string(),
                size,
                last_modified,
                url,
            });
        }
    }

    files.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    Ok(files)
}

#[tauri::command]
async fn delete_file(key: String) -> Result<(), String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    client
        .delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to delete object: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn rename_file(old_key: String, new_key: String) -> Result<(), String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    let copy_source = format!("{}/{}", bucket, old_key);
    client
        .copy_object()
        .bucket(&bucket)
        .copy_source(copy_source)
        .key(&new_key)
        .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead) // Preserve public read ACL
        .send()
        .await
        .map_err(|e| format!("Failed to copy object: {}", e))?;

    client
        .delete_object()
        .bucket(&bucket)
        .key(&old_key)
        .send()
        .await
        .map_err(|e| format!("Failed to delete old object: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn set_object_acl(key: String) -> Result<(), String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    client
        .put_object_acl()
        .bucket(&bucket)
        .key(&key)
        .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
        .send()
        .await
        .map_err(|e| format!("Failed to set object ACL: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn copy_to_clipboard(_text: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn initiate_multipart_upload(filename: String, contentType: String) -> Result<(String, String), String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    // Generate unique key with timestamp
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("{}_{}", timestamp, filename);

    let response = client
        .create_multipart_upload()
        .bucket(&bucket)
        .key(&key)
        .content_type(&contentType)
        .send()
        .await
        .map_err(|e| format!("Failed to initiate multipart upload: {}", e))?;

    Ok((response.upload_id().unwrap().to_string(), key))
}

#[tauri::command]
async fn generate_presigned_url_for_part(
    uploadId: String,
    partNumber: i32,
    key: String,
) -> Result<String, String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    let presigned_request = client
        .upload_part()
        .bucket(&bucket)
        .key(&key)
        .upload_id(&uploadId)
        .part_number(partNumber)
        .presigned(PresigningConfig::expires_in(Duration::from_secs(3600)).unwrap())
        .await
        .map_err(|e| format!("Failed to create presigned URL for part: {}", e))?;

    Ok(presigned_request.uri().to_string())
}

#[tauri::command]
async fn complete_multipart_upload(
    uploadId: String,
    key: String,
    parts: Vec<(i32, String)>, // (part_number, etag)
) -> Result<String, String> {
    let aws_access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID not found")?;
    let aws_secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY not found")?;
    let aws_region = std::env::var("AWS_REGION")
        .unwrap_or_else(|_| "eu-west-1".to_string());
    let bucket = std::env::var("AWS_BUCKET")
        .unwrap_or_else(|_| "uppy.weteling.com".to_string());

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(aws_region.clone()))
        .credentials_provider(S3Credentials::new(&aws_access_key, &aws_secret_key, None, None, "uppy"))
        .load()
        .await;

    let client = S3Client::new(&config);

    // Convert parts to S3 format
    let completed_parts: Vec<_> = parts
        .into_iter()
        .map(|(part_number, etag)| {
            aws_sdk_s3::types::CompletedPart::builder()
                .part_number(part_number)
                .e_tag(&etag)
                .build()
        })
        .collect();

    let completed_multipart_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
        .set_parts(Some(completed_parts))
        .build();

    let response = client
        .complete_multipart_upload()
        .bucket(&bucket)
        .key(&key)
        .upload_id(&uploadId)
        .multipart_upload(completed_multipart_upload)
        .send()
        .await
        .map_err(|e| format!("Failed to complete multipart upload: {}", e))?;

    // Set ACL to public read
    client
        .put_object_acl()
        .bucket(&bucket)
        .key(&key)
        .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
        .send()
        .await
        .map_err(|e| format!("Failed to set object ACL: {}", e))?;

    let file_url = format!("https://s3.{}.amazonaws.com/{}/{}", aws_region, bucket, key);
    Ok(file_url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            generate_presigned_post,
            list_uploaded_files,
            delete_file,
            rename_file,
            set_object_acl,
            copy_to_clipboard,
            initiate_multipart_upload,
            generate_presigned_url_for_part,
            complete_multipart_upload
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
