## Uppy

Uppy is a small program that allows you to upload files rapidly to AWS s3, using a browser upload, so that it uploads directly to S3 and therefor does not have any limits to the file size.

When the upload is done, the app should have a system notification with a notification banner on the system icon.

When you open the app, you should be able to drag and drop files into it that start uploading. And if you do not drag and drop you see in order of activity the files that you have uplaoded, there should be a share button thare that copies the url to the clipboard and a delete button. When you double press on the name you should be able to alter the name of the file.

To start the server you can run `pnpm tauri dev` use the playwright MCP to view the contents.
The AWS s3 credentials are in the path.

Keep going until it works, looks nice, and you are free to add some features if you deem them functional
