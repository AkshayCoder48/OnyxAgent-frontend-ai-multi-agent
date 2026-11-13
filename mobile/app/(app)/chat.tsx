import { ClonePage } from '../../src/page';
import { S3Chat } from '../../src/./screens-chat';

export default function Page() {
  return (
    <ClonePage kind="chat">
      <S3Chat />
    </ClonePage>
  );
}
